require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { loginYNavegarSRT, obtenerExpedientes, obtenerMovimientos, obtenerPdfMovimiento } = require('./scrapers/srt');
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

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'srt-scraper', version: '3.1' }));

// TEST PDF
app.post('/srt/test-pdf', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    const success = await loginYNavegarSRT(page, usuario, password);
    if (!success) return res.json({ success: false, error: 'No se pudo acceder a SRT' });
    
    const expedientes = await obtenerExpedientes(page);
    if (expedientes.length === 0) return res.json({ success: false, error: 'Sin expedientes' });
    
    const movimientos = await obtenerMovimientos(page, expedientes[0].oid);
    if (movimientos.length === 0) return res.json({ success: false, error: 'Sin movimientos' });
    
    const pdf = await obtenerPdfMovimiento(page, movimientos[0].ingresoOid);
    
    res.json({ success: true, expediente: expedientes[0].nro, movimiento: movimientos[0], pdf });
  } catch (error) {
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
    if (!success) return res.json({ success: false, error: 'No se pudo acceder a SRT', expedientes: [] });
    
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
    if (!success) return res.json({ success: false, error: 'No se pudo acceder a SRT', total: 0, conMatch: [], sinMatch: [] });
    
    const expedientes = await obtenerExpedientes(page);
    const resultado = { total: expedientes.length, conMatch: [], sinMatch: [] };
    
    for (const exp of expedientes) {
      const caso = await buscarCasoPorNumeroSrt(exp.nro);
      if (caso) {
        resultado.conMatch.push({ eservicios: { nro: exp.nro, nombre: exp.damnificadoNombre }, caso_srt: { id: caso.id, nombre: caso.nombre, numero_srt: caso.numero_srt } });
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

app.post('/srt/importar-movimientos-masivo', async (req, res) => {
  const { usuario, password, limit } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const stats = { expedientesSrt: 0, conMatch: 0, sinMatch: 0, movimientosInsertados: 0, errores: [] };
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    const success = await loginYNavegarSRT(page, usuario, password);
    if (!success) return res.json({ success: false, error: 'No se pudo acceder a SRT', stats });
    
    let expedientes = await obtenerExpedientes(page);
    stats.expedientesSrt = expedientes.length;
    if (limit) expedientes = expedientes.slice(0, limit);
    
    for (const exp of expedientes) {
      const caso = await buscarCasoPorNumeroSrt(exp.nro);
      if (!caso) { stats.sinMatch++; continue; }
      
      stats.conMatch++;
      const movimientos = await obtenerMovimientos(page, exp.oid);
      
      for (const mov of movimientos) {
        console.log('💾 Insertando:', { caso_srt_id: caso.id, srt_ingreso_oid: mov.ingresoOid });
        const { error } = await supabase.from('movimientos_srt').upsert({
          caso_srt_id: caso.id, srt_expediente_oid: exp.oid, srt_expediente_nro: exp.nro,
          srt_ingreso_oid: mov.ingresoOid, srt_ingreso_nro: mov.ingresoNro, fecha: mov.fecha,
          tipo_codigo: mov.tipoCodigo, tipo_descripcion: mov.tipoDescripcion, damnificado_nombre: exp.damnificadoNombre
        }, { onConflict: 'caso_srt_id,srt_ingreso_oid', ignoreDuplicates: true });
        
        if (error) {
          console.log('❌ Error insert:', error.message);
          stats.errores.push(error.message);
        } else {
          stats.movimientosInsertados++;
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ error: error.message, stats });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('🚀 SRT Scraper v3.1 en puerto ' + PORT); });
