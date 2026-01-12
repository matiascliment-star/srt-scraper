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

// ============================================================
// RATE LIMITING - Solo 1 browser a la vez para PDFs
// ============================================================
let pdfBrowserEnUso = false;
const PDF_QUEUE = [];

async function esperarTurnoPdf() {
  if (!pdfBrowserEnUso) {
    pdfBrowserEnUso = true;
    return;
  }
  
  // Esperar en cola
  return new Promise((resolve) => {
    PDF_QUEUE.push(resolve);
  });
}

function liberarTurnoPdf() {
  if (PDF_QUEUE.length > 0) {
    const siguiente = PDF_QUEUE.shift();
    siguiente();
  } else {
    pdfBrowserEnUso = false;
  }
}

// ============================================================

function parseFechaSrt(fechaStr) {
  if (!fechaStr || fechaStr.trim() === '') return null;
  const match = fechaStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2})?:?(\d{2})?/);
  if (!match) return null;
  const [_, dia, mes, anio, hora = '00', min = '00'] = match;
  return new Date(`${anio}-${mes}-${dia}T${hora}:${min}:00`);
}

function normalizarNumeroSrt(numero) {
  if (!numero) return null;
  let limpio = numero.replace(/^(CABA|MATANZA|LOMAS|QUILMES|MORON|SAN MARTIN|LA PLATA|AVELLANEDA)?\s*\/?\s*/i, '').trim();
  limpio = limpio.replace(/-/g, '/');
  const match = limpio.match(/(\d+)\s*\/\s*(\d+)/);
  return match ? `${match[1]}/${match[2]}` : null;
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'SRT Scraper v7.2',
    pdfQueueLength: PDF_QUEUE.length,
    pdfBrowserEnUso
  });
});

// VINCULAR CASOS + LISTAR EXPEDIENTES
app.post('/srt/vincular-casos', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  
  const stats = { casosEncontrados: 0, casosVinculados: 0, casosSinMatch: 0 };
  let browser;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    const loginOk = await loginYNavegarSRT(page, usuario, password);
    if (!loginOk) { await browser.close(); return res.status(401).json({ error: 'Login fallido' }); }
    
    await navegarAExpedientes(page);
    const expedientesSrt = await obtenerExpedientes(page);
    await browser.close();
    
    console.log(`✅ Expedientes SRT obtenidos: ${expedientesSrt.length}`);
    
    const mapaSrt = {};
    for (const exp of expedientesSrt) {
      const nroNorm = normalizarNumeroSrt(exp.nro);
      if (nroNorm) mapaSrt[nroNorm] = exp;
    }
    
    const { data: casos } = await supabase
      .from('casos_srt')
      .select('id, numero_srt')
      .is('srt_expediente_oid', null)
      .not('numero_srt', 'is', null);
    
    stats.casosEncontrados = casos?.length || 0;
    
    for (const caso of casos || []) {
      const nroNorm = normalizarNumeroSrt(caso.numero_srt);
      if (nroNorm && mapaSrt[nroNorm]) {
        const exp = mapaSrt[nroNorm];
        await supabase
          .from('casos_srt')
          .update({ 
            srt_expediente_oid: exp.oid,
            url_pdf_expediente: `https://srt-scraper-production.up.railway.app/srt/expediente-pdf/${exp.oid}`
          })
          .eq('id', caso.id);
        stats.casosVinculados++;
      } else {
        stats.casosSinMatch++;
      }
    }
    
    res.json({ 
      success: true, 
      stats,
      expedientes: expedientesSrt.map(exp => ({
        numero: exp.nro,
        oid: exp.oid,
        nombre: exp.damnificadoNombre || null,
        cuil: exp.damnificadoCuil || null,
        motivo: exp.motivo || null
      }))
    });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

// DESCARGAR PDF EXPEDIENTE - CON RATE LIMITING
app.get('/srt/expediente-pdf/:oid', async (req, res) => {
  const { oid } = req.params;
  console.log('📥 PDF expediente OID:', oid, '| Cola:', PDF_QUEUE.length);
  
  let browser;
  
  try {
    // Esperar turno
    await esperarTurnoPdf();
    console.log('🔓 Turno obtenido para expediente:', oid);
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
    });
    
    const page = await browser.newPage();
    const loginOk = await loginYNavegarSRT(page, process.env.SRT_USER, process.env.SRT_PASS);
    if (!loginOk) {
      throw new Error('Login fallido');
    }
    
    await navegarAExpedientes(page);
    await delay(2000);
    
    const pdfData = await page.evaluate(async (expedienteOid) => {
      const res = await fetch('https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx/ObtenerPDF', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ OID: parseInt(expedienteOid) }),
        credentials: 'include'
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const data = await res.json();
      return { data: data.d };
    }, oid);
    
    await browser.close();
    browser = null;
    
    if (!pdfData.data) {
      throw new Error('PDF no encontrado');
    }
    
    const pdfBuffer = Buffer.from(pdfData.data, 'base64');
    console.log('📥 PDF expediente:', pdfBuffer.length, 'bytes');
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="expediente_${oid}.pdf"`);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('❌ Error expediente-pdf:', error.message);
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  } finally {
    liberarTurnoPdf();
    console.log('🔒 Turno liberado, cola restante:', PDF_QUEUE.length);
  }
});

// DESCARGAR PDF ADJUNTO DE COMUNICACIÓN - CON RATE LIMITING
app.get('/srt/adjunto-pdf/:id', async (req, res) => {
  const { id } = req.params;
  console.log('📎 PDF adjunto ID:', id, '| Cola:', PDF_QUEUE.length);
  
  let browser;
  
  try {
    // Esperar turno
    await esperarTurnoPdf();
    console.log('🔓 Turno obtenido para adjunto:', id);
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
    });
    
    const page = await browser.newPage();
    const loginOk = await loginYNavegarSRT(page, process.env.SRT_USER, process.env.SRT_PASS);
    if (!loginOk) {
      throw new Error('Login fallido');
    }
    
    // Construir objeto adjunto con la URL de descarga
    const archivoAdjunto = {
      id: id,
      href: `https://eservicios.srt.gob.ar/MiVentanilla/Download.aspx?id=${id}`
    };
    
    const pdfData = await descargarPdf(page, archivoAdjunto);
    
    await browser.close();
    browser = null;
    
    if (pdfData.error) {
      throw new Error(pdfData.error);
    }
    
    if (!pdfData.base64) {
      throw new Error('PDF no encontrado');
    }
    
    const pdfBuffer = Buffer.from(pdfData.base64, 'base64');
    console.log('📎 PDF adjunto:', pdfBuffer.length, 'bytes');
    
    res.setHeader('Content-Type', pdfData.isPdf ? 'application/pdf' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="adjunto_${id}.pdf"`);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('❌ Error adjunto-pdf:', error.message);
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  } finally {
    liberarTurnoPdf();
    console.log('🔒 Turno liberado, cola restante:', PDF_QUEUE.length);
  }
});

// IMPORTAR COMUNICACIONES - CON RELOGIN CADA 50 CASOS
app.post('/srt/importar-comunicaciones', async (req, res) => {
  const { usuario, password, limit = 500 } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  
  const stats = { procesados: 0, comunicacionesNuevas: 0, existentes: 0, adjuntos: 0, errores: [] };
  let browser;
  let page;
  const RELOGIN_CADA = 50;
  
  try {
    const { data: casos } = await supabase
      .from('casos_srt')
      .select('id, srt_expediente_oid, numero_srt')
      .not('srt_expediente_oid', 'is', null)
      .limit(limit);
    
    if (!casos?.length) return res.json({ success: true, message: 'No hay casos', stats });
    
    console.log(`📋 Procesando ${casos.length} casos`);
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
    });
    
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    let loginOk = await loginYNavegarSRT(page, usuario, password);
    if (!loginOk) { await browser.close(); return res.status(401).json({ error: 'Login fallido' }); }
    
    await navegarAExpedientes(page);
    
    for (let i = 0; i < casos.length; i++) {
      const caso = casos[i];
      
      // Relogin cada 50 casos
      if (i > 0 && i % RELOGIN_CADA === 0) {
        console.log(`🔄 Relogin después de ${i} casos...`);
        await page.close();
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        loginOk = await loginYNavegarSRT(page, usuario, password);
        if (!loginOk) {
          stats.errores.push({ caso: caso.numero_srt, error: 'Relogin fallido' });
          continue;
        }
        await navegarAExpedientes(page);
      }
      
      try {
        console.log(`📁 [${i+1}/${casos.length}] ${caso.numero_srt}`);
        stats.procesados++;
        
        const comunicaciones = await obtenerComunicaciones(page, caso.srt_expediente_oid);
        
        for (const com of comunicaciones) {
          if (!com.traID) continue;
          
          const { data: existe } = await supabase
            .from('comunicaciones_srt')
            .select('id')
            .eq('srt_tra_id', com.traID)
            .single();
          
          if (existe) {
            stats.existentes++;
            continue;
          }
          
          const detalle = await obtenerDetalleComunicacion(page, com.traID, com.catID, com.tipoActor);
          
          const { data: nuevaCom, error: errorCom } = await supabase
            .from('comunicaciones_srt')
            .insert({
              caso_srt_id: caso.id,
              srt_expediente_oid: caso.srt_expediente_oid,
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
          
          if (errorCom) continue;
          stats.comunicacionesNuevas++;
          
          for (const adj of detalle.archivosAdjuntos || []) {
            await supabase.from('adjuntos_comunicacion_srt').insert({
              comunicacion_id: nuevaCom.id,
              srt_adjunto_id: adj.id,
              srt_id_tipo_ref: adj.idTipoRef,
              nombre: adj.nombre,
              url_descarga: adj.href
            });
            stats.adjuntos++;
          }
        }
      } catch (e) {
        console.log(`❌ ${caso.numero_srt}: ${e.message}`);
        stats.errores.push(caso.numero_srt);
      }
    }
    
    await browser.close();
    console.log('📊 Resumen:', stats);
    res.json({ success: true, stats });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message, stats });
  }
});

app.get('/srt/comunicaciones/:expedienteOid', async (req, res) => {
  const { data, error } = await supabase
    .from('comunicaciones_srt')
    .select('*, adjuntos_comunicacion_srt (*)')
    .eq('srt_expediente_oid', req.params.expedienteOid)
    .order('fecha_notificacion', { ascending: false });
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ comunicaciones: data });
});

// IMPORTAR COMUNICACIONES DE UN SOLO EXPEDIENTE
app.post('/srt/importar-comunicaciones-expediente', async (req, res) => {
  const { usuario, password, expedienteOid, casoSrtId } = req.body;
  if (!usuario || !password || !expedienteOid) {
    return res.status(400).json({ error: 'Faltan credenciales o expedienteOid' });
  }
  
  const stats = { comunicacionesNuevas: 0, existentes: 0, adjuntos: 0 };
  let browser;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    const loginOk = await loginYNavegarSRT(page, usuario, password);
    if (!loginOk) { 
      await browser.close(); 
      return res.status(401).json({ error: 'Login fallido' }); 
    }
    
    await navegarAExpedientes(page);
    
    console.log(`📁 Importando comunicaciones del expediente OID: ${expedienteOid}`);
    
    const comunicaciones = await obtenerComunicaciones(page, expedienteOid);
    
    for (const com of comunicaciones) {
      if (!com.traID) continue;
      
      const { data: existe } = await supabase
        .from('comunicaciones_srt')
        .select('id')
        .eq('srt_tra_id', com.traID)
        .single();
      
      if (existe) {
        stats.existentes++;
        continue;
      }
      
      const detalle = await obtenerDetalleComunicacion(page, com.traID, com.catID, com.tipoActor);
      
      const { data: nuevaCom, error: errorCom } = await supabase
        .from('comunicaciones_srt')
        .insert({
          caso_srt_id: casoSrtId || null,
          srt_expediente_oid: expedienteOid,
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
        console.log(`⚠️ Error insertando comunicación: ${errorCom.message}`);
        continue;
      }
      
      stats.comunicacionesNuevas++;
      
      for (const adj of detalle.archivosAdjuntos || []) {
        await supabase.from('adjuntos_comunicacion_srt').insert({
          comunicacion_id: nuevaCom.id,
          srt_adjunto_id: adj.id,
          srt_id_tipo_ref: adj.idTipoRef,
          nombre: adj.nombre,
          url_descarga: adj.href
        });
        stats.adjuntos++;
      }
    }
    
    await browser.close();
    
    console.log(`✅ Comunicaciones importadas:`, stats);
    res.json({ success: true, stats });
    
  } catch (error) {
    console.error('❌ Error importando comunicaciones:', error.message);
    if (browser) await browser.close();
    res.status(500).json({ error: error.message, stats });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 SRT Scraper v7.2 en puerto ${PORT}`));
