require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { 
  loginYNavegarSRT, 
  navegarAExpedientes,
  obtenerExpedientes, 
  obtenerComunicaciones,
  obtenerDetalleComunicacion,
  descargarPdf,
  delay
} = require('./scrapers/srt');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function normalizarNumeroSrt(numero) {
  if (!numero) return null;
  let limpio = numero.replace(/^(CABA|MATANZA|LOMAS|QUILMES|MORON|SAN MARTIN|LA PLATA|AVELLANEDA)\s*\/?\s*/i, '').replace(/^\s*\/\s*/, '').trim();
  limpio = limpio.replace(/-/g, '/');
  const match = limpio.match(/(\d+)\s*\/\s*(\d+)/);
  return match ? match[1] + '/' + match[2] : limpio;
}

async function buscarCasoPorNumeroSrt(numeroSrt) {
  const normalizado = normalizarNumeroSrt(numeroSrt);
  if (!normalizado) return null;
  const { data: casos } = await supabase.from('casos_srt').select('id, nombre, numero_srt').not('numero_srt', 'is', null);
  if (!casos) return null;
  for (const caso of casos) {
    if (normalizarNumeroSrt(caso.numero_srt) === normalizado) return caso;
  }
  return null;
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'srt-scraper', version: '4.2' }));

// TEST: Ver comunicaciones de un expediente
app.post('/srt/test-comunicaciones', async (req, res) => {
  const { usuario, password, expedienteOid } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    const success = await loginYNavegarSRT(page, usuario, password);
    if (!success) return res.json({ success: false, error: 'No se pudo acceder a SRT' });
    
    await navegarAExpedientes(page);
    const expedientes = await obtenerExpedientes(page);
    
    const oid = expedienteOid || expedientes[0]?.oid;
    if (!oid) return res.json({ success: false, error: 'No hay expedientes' });
    
    const comunicaciones = await obtenerComunicaciones(page, oid);
    
    // Si encontramos comunicaciones, obtener detalle de la primera
    let detalle = null;
    let pdf = null;
    
    if (comunicaciones && comunicaciones.length > 0 && comunicaciones[0].traID) {
      detalle = await obtenerDetalleComunicacion(page, comunicaciones[0].traID);
      
      // Intentar descargar el primer PDF
      if (detalle.archivosAdjuntos && detalle.archivosAdjuntos.length > 0) {
        pdf = await descargarPdf(page, detalle.archivosAdjuntos[0]);
        pdf.base64 = pdf.base64 ? pdf.base64.substring(0, 100) + '...' : null; // Truncar para respuesta
      }
    }
    
    res.json({ 
      success: true, 
      expedienteOid: oid,
      totalComunicaciones: comunicaciones ? comunicaciones.length : 0,
      comunicaciones: comunicaciones ? comunicaciones.slice(0, 5) : [], // Solo primeras 5
      detalleEjemplo: detalle,
      pdfEjemplo: pdf
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

app.post('/srt/expedientes', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    const success = await loginYNavegarSRT(page, usuario, password);
    if (!success) return res.json({ success: false, error: 'No se pudo acceder a SRT' });
    
    await navegarAExpedientes(page);
    const expedientes = await obtenerExpedientes(page);
    res.json({ success: true, total: expedientes.length, expedientes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

app.post('/srt/test-matching', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    const success = await loginYNavegarSRT(page, usuario, password);
    if (!success) return res.json({ success: false, error: 'No se pudo acceder a SRT' });
    
    await navegarAExpedientes(page);
    const expedientes = await obtenerExpedientes(page);
    const resultado = { total: expedientes.length, conMatch: [], sinMatch: [] };
    
    for (const exp of expedientes) {
      const caso = await buscarCasoPorNumeroSrt(exp.nro);
      if (caso) {
        resultado.conMatch.push({ eservicios: { nro: exp.nro, nombre: exp.damnificadoNombre }, caso_srt: { id: caso.id, nombre: caso.nombre } });
      } else {
        resultado.sinMatch.push({ nro: exp.nro, nombre: exp.damnificadoNombre });
      }
    }
    
    res.json({ success: true, ...resultado, resumen: { conMatch: resultado.conMatch.length, sinMatch: resultado.sinMatch.length } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('🚀 SRT Scraper v4.2 en puerto ' + PORT); });
