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

// Parsear fecha DD/MM/YYYY HH:mm a Date
function parseFechaSrt(fechaStr) {
  if (!fechaStr || fechaStr.trim() === '') return null;
  const match = fechaStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2})?:?(\d{2})?/);
  if (!match) return null;
  const [_, dia, mes, anio, hora = '00', min = '00'] = match;
  return new Date(`${anio}-${mes}-${dia}T${hora}:${min}:00`);
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SRT Scraper v6' });
});

// Test comunicaciones (existente)
app.post('/srt/test-comunicaciones', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  
  let browser;
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
    
    // Buscar expediente con comunicaciones sin leer
    const expConComunicaciones = expedientes.find(e => e.comunicacionesSinLectura > 0) || expedientes[0];
    
    const comunicaciones = await obtenerComunicaciones(page, expConComunicaciones.oid);
    
    let detalleEjemplo = null;
    let pdfEjemplo = null;
    
    if (comunicaciones.length > 0 && comunicaciones[0].traID) {
      detalleEjemplo = await obtenerDetalleComunicacion(page, comunicaciones[0].traID);
      
      if (detalleEjemplo.archivosAdjuntos?.length > 0) {
        pdfEjemplo = await descargarPdf(page, detalleEjemplo.archivosAdjuntos[0]);
      }
    }
    
    await browser.close();
    
    res.json({
      success: true,
      expedienteOid: expConComunicaciones.oid,
      totalComunicaciones: comunicaciones.length,
      comunicaciones: comunicaciones.slice(0, 5),
      detalleEjemplo,
      pdfEjemplo: pdfEjemplo ? { size: pdfEjemplo.size, type: pdfEjemplo.type, isPdf: pdfEjemplo.isPdf } : null
    });
    
  } catch (error) {
    console.error('Error:', error);
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

// IMPORTACIÓN MASIVA DE COMUNICACIONES
app.post('/srt/importar-comunicaciones', async (req, res) => {
  const { usuario, password, limit = 10, soloConComunicaciones = true } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  
  let browser;
  const stats = {
    expedientesProcesados: 0,
    comunicacionesNuevas: 0,
    comunicacionesExistentes: 0,
    adjuntosDescargados: 0,
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
    
    // Filtrar expedientes
    let expedientesAProcessar = soloConComunicaciones 
      ? expedientes.filter(e => e.comunicacionesSinLectura > 0)
      : expedientes;
    
    expedientesAProcessar = expedientesAProcessar.slice(0, limit);
    
    console.log(`📋 Procesando ${expedientesAProcessar.length} expedientes...`);
    
    for (const exp of expedientesAProcessar) {
      try {
        console.log(`\n📁 Expediente ${exp.nro} (OID: ${exp.oid})`);
        stats.expedientesProcesados++;
        
        // Buscar caso_srt correspondiente
        const { data: casoSrt } = await supabase
          .from('casos_srt')
          .select('id')
          .eq('srt_expediente_oid', exp.oid)
          .single();
        
        const comunicaciones = await obtenerComunicaciones(page, exp.oid);
        console.log(`  📨 ${comunicaciones.length} comunicaciones`);
        
        for (const com of comunicaciones) {
          if (!com.traID) continue;
          
          // Verificar si ya existe
          const { data: existe } = await supabase
            .from('comunicaciones_srt')
            .select('id')
            .eq('srt_tra_id', com.traID)
            .single();
          
          if (existe) {
            stats.comunicacionesExistentes++;
            continue;
          }
          
          // Obtener detalle
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
            console.log(`  ❌ Error insertando comunicación:`, errorCom.message);
            stats.errores.push({ traID: com.traID, error: errorCom.message });
            continue;
          }
          
          stats.comunicacionesNuevas++;
          console.log(`  ✅ Comunicación ${com.traID} insertada`);
          
          // Descargar adjuntos
          for (const adjunto of detalle.archivosAdjuntos || []) {
            try {
              const pdfData = await descargarPdf(page, adjunto);
              
              if (!pdfData.isPdf) {
                console.log(`  ⚠️ Adjunto ${adjunto.nombre} no es PDF`);
                continue;
              }
              
              // Subir a Supabase Storage
              const storagePath = `${exp.oid}/${com.traID}/${adjunto.nombre}`;
              const pdfBuffer = Buffer.from(pdfData.base64, 'base64');
              
              const { error: uploadError } = await supabase.storage
                .from('comunicaciones-srt')
                .upload(storagePath, pdfBuffer, {
                  contentType: 'application/pdf',
                  upsert: true
                });
              
              if (uploadError) {
                console.log(`  ❌ Error subiendo PDF:`, uploadError.message);
                continue;
              }
              
              // Obtener URL pública
              const { data: urlData } = supabase.storage
                .from('comunicaciones-srt')
                .getPublicUrl(storagePath);
              
              // Insertar adjunto
              await supabase
                .from('adjuntos_comunicacion_srt')
                .insert({
                  comunicacion_id: nuevaCom.id,
                  srt_adjunto_id: adjunto.id,
                  nombre: adjunto.nombre,
                  tamanio: pdfData.size,
                  storage_path: storagePath,
                  url_publica: urlData.publicUrl
                });
              
              stats.adjuntosDescargados++;
              console.log(`  📎 Adjunto ${adjunto.nombre} subido`);
              
            } catch (adjError) {
              console.log(`  ❌ Error con adjunto:`, adjError.message);
              stats.errores.push({ adjunto: adjunto.nombre, error: adjError.message });
            }
          }
          
          await delay(1000); // Rate limiting
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

// Obtener comunicaciones de un expediente (para la app)
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
  console.log(`🚀 SRT Scraper v6 en puerto ${PORT}`);
});
