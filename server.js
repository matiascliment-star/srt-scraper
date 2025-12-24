require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const { 
  loginYNavegarSRT, 
  navegarAExpedientes, 
  obtenerExpedientes, 
  obtenerComunicaciones,
  obtenerDetalleComunicacion,
  descargarPdf,
  delay 
} = require('./scrapers/srt');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function parseFechaSrt(fechaStr) {
  if (!fechaStr || fechaStr.trim() === '') return null;
  const match = fechaStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2})?:?(\d{2})?/);
  if (!match) return null;
  const [_, dia, mes, anio, hora = '00', min = '00'] = match;
  return new Date(`${anio}-${mes}-${dia}T${hora}:${min}:00`);
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SRT Scraper v6.2' });
});

// IMPORTACIÓN MASIVA - SIN DESCARGAR PDFs (RÁPIDO)
app.post('/srt/importar-comunicaciones', async (req, res) => {
  const { usuario, password, limit = 50 } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  
  let browser;
  const stats = {
    expedientesProcesados: 0,
    comunicacionesNuevas: 0,
    comunicacionesExistentes: 0,
    adjuntosRegistrados: 0,
    errores: []
  };
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    const loginOk = await loginYNavegarSRT(page, usuario, password);
    if (!loginOk) {
      return res.status(401).json({ error: 'Login fallido' });
    }
    
    await navegarAExpedientes(page);
    const expedientes = await obtenerExpedientes(page);
    const expedientesAProcessar = expedientes.slice(0, limit);
    
    console.log(`📋 Procesando ${expedientesAProcessar.length} expedientes...`);
    
    for (const exp of expedientesAProcessar) {
      try {
        console.log(`\n📁 Expediente ${exp.nro} (OID: ${exp.oid})`);
        stats.expedientesProcesados++;
        
        const { data: casoSrt } = await supabase
          .from('casos_srt')
          .select('id')
          .eq('srt_expediente_oid', exp.oid)
          .single();
        
        const comunicaciones = await obtenerComunicaciones(page, exp.oid);
        console.log(`  📨 ${comunicaciones.length} comunicaciones`);
        
        for (const com of comunicaciones) {
          if (!com.traID) continue;
          
          const { data: existe } = await supabase
            .from('comunicaciones_srt')
            .select('id')
            .eq('srt_tra_id', com.traID)
            .single();
          
          if (existe) {
            stats.comunicacionesExistentes++;
            continue;
          }
          
          // Obtener detalle (para sacar los adjuntos)
          const detalle = await obtenerDetalleComunicacion(page, com.traID, com.catID, com.tipoActor);
          
          // Insertar comunicación
          const { data: nuevaCom, error: errorCom } = await supabase
            .from('comunicaciones_srt')
            .insert({
              caso_srt_id: casoSrt?.id || null,
              srt_expediente_oid: exp.oid,
              srt_expediente_nro: com.expediente,
              srt_tra_id: com.traID,
              fecha_notificacion: parseFechaSrt(com.fechaNotificacion),
              remitente: com.remitente,
              sector: com.sector,
              tipo_comunicacion: com.tipoComunicacion,
              estado: com.estado,
              fecha_estado: parseFechaSrt(com.fechaUltEstado),
              detalle: detalle.detalle || null
            })
            .select()
            .single();
          
          if (errorCom) {
            stats.errores.push({ traID: com.traID, error: errorCom.message });
            continue;
          }
          
          stats.comunicacionesNuevas++;
          console.log(`  ✅ Comunicación ${com.traID}`);
          
          // Guardar adjuntos SIN DESCARGAR - solo la URL
          for (const adjunto of detalle.archivosAdjuntos || []) {
            await supabase
              .from('adjuntos_comunicacion_srt')
              .insert({
                comunicacion_id: nuevaCom.id,
                srt_adjunto_id: adjunto.id,
                srt_id_tipo_ref: adjunto.idTipoRef,
                nombre: adjunto.nombre,
                url_descarga: adjunto.href
              });
            
            stats.adjuntosRegistrados++;
          }
          
          await delay(500); // Rate limiting mínimo
        }
        
      } catch (expError) {
        console.log(`❌ Error en expediente ${exp.nro}:`, expError.message);
        stats.errores.push({ expediente: exp.nro, error: expError.message });
      }
    }
    
    await browser.close();
    
    console.log('\n📊 Resumen:', stats);
    res.json({ success: true, stats });
    
  } catch (error) {
    console.error('Error:', error);
    if (browser) await browser.close();
    res.status(500).json({ error: error.message, stats });
  }
});

// DESCARGAR PDF ON-DEMAND
app.get('/srt/pdf/:adjuntoId', async (req, res) => {
  const { adjuntoId } = req.params;
  
  // Obtener datos del adjunto
  const { data: adjunto, error } = await supabase
    .from('adjuntos_comunicacion_srt')
    .select('*')
    .eq('id', adjuntoId)
    .single();
  
  if (error || !adjunto) {
    return res.status(404).json({ error: 'Adjunto no encontrado' });
  }
  
  // Si ya está en storage, redirigir
  if (adjunto.url_publica) {
    return res.redirect(adjunto.url_publica);
  }
  
  // Descargar del SRT
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const page = await browser.newPage();
    
    // Login
    const loginOk = await loginYNavegarSRT(page, process.env.SRT_USER, process.env.SRT_PASS);
    if (!loginOk) {
      await browser.close();
      return res.status(500).json({ error: 'No se pudo conectar a SRT' });
    }
    
    // Navegar para establecer sesión
    await navegarAExpedientes(page);
    
    // Descargar PDF
    const pdfData = await descargarPdf(page, { href: adjunto.url_descarga, nombre: adjunto.nombre });
    await browser.close();
    
    if (!pdfData.isPdf) {
      return res.status(500).json({ error: 'No se pudo obtener el PDF' });
    }
    
    // Enviar PDF directamente
    const pdfBuffer = Buffer.from(pdfData.base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${adjunto.nombre}"`);
    res.send(pdfBuffer);
    
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

// Obtener comunicaciones de un expediente
app.get('/srt/comunicaciones/:expedienteOid', async (req, res) => {
  const { expedienteOid } = req.params;
  
  const { data, error } = await supabase
    .from('comunicaciones_srt')
    .select(`
      *,
      adjuntos_comunicacion_srt (*)
    `)
    .eq('srt_expediente_oid', expedienteOid)
    .order('fecha_notificacion', { ascending: false });
  
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  
  res.json({ comunicaciones: data });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 SRT Scraper v6.2 en puerto ${PORT}`);
});
