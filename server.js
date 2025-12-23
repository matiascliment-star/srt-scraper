require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const {
  obtenerExpedientes,
  obtenerMovimientos,
  loginAfip,
  navegarAeServicios
} = require('./scrapers/srt');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// =============================================
// HELPER: Normalizar número SRT para comparación
// Convierte cualquier formato a "NNNNNN/AA"
// =============================================
function normalizarNumeroSrt(numero) {
  if (!numero) return null;
  
  // Limpiar: quitar prefijos como "CABA /", "/ ", espacios
  let limpio = numero
    .replace(/^(CABA|MATANZA|LOMAS|QUILMES|MORON|SAN MARTIN|LA PLATA|AVELLANEDA)\s*\/?\s*/i, '')
    .replace(/^\s*\/\s*/, '')
    .trim();
  
  // Convertir guiones a barras: "430803-25" → "430803/25"
  limpio = limpio.replace(/-/g, '/');
  
  // Asegurar que tenga formato NNNNNN/AA
  const match = limpio.match(/(\d+)\s*\/\s*(\d+)/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  
  return limpio;
}

// =============================================
// HELPER: Buscar caso_srt por número de expediente
// =============================================
async function buscarCasoPorNumeroSrt(numeroSrtEservicios) {
  // numeroSrtEservicios viene como "61485/25" de e-Servicios
  const normalizado = normalizarNumeroSrt(numeroSrtEservicios);
  if (!normalizado) return null;
  
  // Obtener todos los casos_srt con numero_srt
  const { data: casos, error } = await supabase
    .from('casos_srt')
    .select('id, nombre, numero_srt, etapa, estado')
    .not('numero_srt', 'is', null);
  
  if (error || !casos) return null;
  
  // Buscar match normalizando cada numero_srt
  for (const caso of casos) {
    const casoNormalizado = normalizarNumeroSrt(caso.numero_srt);
    if (casoNormalizado === normalizado) {
      return caso;
    }
  }
  
  return null;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'srt-scraper', 
    version: '2.0',
    matching: 'casos_srt.numero_srt',
    timestamp: new Date().toISOString() 
  });
});

// =============================================
// ENDPOINT: Obtener expedientes SRT (sin insertar)
// Solo retorna la lista para ver qué hay
// =============================================
app.post('/srt/expedientes', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  
  console.log('📋 Obteniendo lista de expedientes SRT...');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    await loginAfip(page, usuario, password);
    await navegarAeServicios(page);
    const expedientes = await obtenerExpedientes(page);
    
    console.log(`✅ ${expedientes.length} expedientes encontrados en SRT`);
    
    res.json({ 
      success: true, 
      total: expedientes.length,
      expedientes 
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

// =============================================
// ENDPOINT: Importar movimientos masivo
// 1. Baja expedientes SRT de e-Servicios
// 2. Matchea con tabla casos_srt por numero_srt
// 3. Solo inserta movimientos de los que matchean
// =============================================
app.post('/srt/importar-movimientos-masivo', async (req, res) => {
  const { usuario, password, limit, soloConNovedades } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  
  console.log('🚀 Iniciando importación masiva SRT...');
  console.log('📌 Matching por: casos_srt.numero_srt');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const stats = {
    expedientesSrt: 0,
    expedientesConMatch: 0,
    expedientesSinMatch: 0,
    movimientosEncontrados: 0,
    movimientosInsertados: 0,
    movimientosDuplicados: 0,
    errores: [],
    detalle: {
      conMatch: [],
      sinMatch: []
    }
  };
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // 1. Login y navegar
    await loginAfip(page, usuario, password);
    await navegarAeServicios(page);
    
    // 2. Obtener expedientes de e-Servicios SRT
    let expedientesSrt = await obtenerExpedientes(page);
    stats.expedientesSrt = expedientesSrt.length;
    
    console.log(`📋 ${expedientesSrt.length} expedientes en e-Servicios SRT`);
    
    // Filtrar solo con novedades si se especifica
    if (soloConNovedades) {
      expedientesSrt = expedientesSrt.filter(e => e.comunicacionesSinLectura > 0);
      console.log(`🔔 ${expedientesSrt.length} con novedades`);
    }
    
    // Aplicar límite si se especifica
    if (limit && limit > 0) {
      expedientesSrt = expedientesSrt.slice(0, limit);
      console.log(`⚠️ Limitado a ${limit} expedientes`);
    }
    
    // 3. Para cada expediente SRT, buscar match en casos_srt
    for (const expSrt of expedientesSrt) {
      const numeroSrt = expSrt.nro; // Formato "61485/25"
      
      // Buscar caso interno por numero_srt
      const casoInterno = await buscarCasoPorNumeroSrt(numeroSrt);
      
      if (!casoInterno) {
        // No hay match - registrar pero no procesar
        stats.expedientesSinMatch++;
        stats.detalle.sinMatch.push({
          srt_nro: numeroSrt,
          nombre: expSrt.damnificadoNombre,
          oid: expSrt.oid
        });
        console.log(`⚪ Sin match: ${numeroSrt} (${expSrt.damnificadoNombre})`);
        continue;
      }
      
      // HAY MATCH - procesar movimientos
      stats.expedientesConMatch++;
      stats.detalle.conMatch.push({
        srt_nro: numeroSrt,
        caso_srt_id: casoInterno.id,
        nombre_caso: casoInterno.nombre,
        nombre_eservicios: expSrt.damnificadoNombre
      });
      
      console.log(`🟢 Match: ${numeroSrt} → caso_srt #${casoInterno.id} (${casoInterno.nombre})`);
      
      try {
        // Obtener movimientos de este expediente
        const movimientos = await obtenerMovimientos(page, expSrt.oid);
        stats.movimientosEncontrados += movimientos.length;
        
        console.log(`   📂 ${movimientos.length} movimientos encontrados`);
        
        // Insertar cada movimiento
        for (const mov of movimientos) {
          const { data, error } = await supabase
            .from('movimientos_srt')
            .upsert({
              caso_srt_id: casoInterno.id,
              srt_expediente_oid: expSrt.oid,
              srt_expediente_nro: numeroSrt,
              srt_ingreso_oid: mov.ingresoOid,
              srt_ingreso_nro: mov.ingresoNro,
              fecha: mov.fecha,
              tipo_codigo: mov.tipoCodigo,
              tipo_descripcion: mov.tipoDescripcion,
              damnificado_nombre: expSrt.damnificadoNombre
            }, {
              onConflict: 'caso_srt_id,srt_ingreso_oid',
              ignoreDuplicates: true
            })
            .select();
          
          if (error) {
            if (error.code === '23505') {
              stats.movimientosDuplicados++;
            } else {
              stats.errores.push({ movimiento: mov.ingresoNro, error: error.message });
            }
          } else {
            stats.movimientosInsertados++;
          }
        }
        
        // Delay para no saturar
        await new Promise(r => setTimeout(r, 500));
        
      } catch (error) {
        console.error(`   ❌ Error en ${numeroSrt}:`, error.message);
        stats.errores.push({ expediente: numeroSrt, error: error.message });
      }
    }
    
    console.log('\n📊 RESUMEN:');
    console.log(`   Expedientes en e-Servicios: ${stats.expedientesSrt}`);
    console.log(`   Con match en casos_srt: ${stats.expedientesConMatch}`);
    console.log(`   Sin match: ${stats.expedientesSinMatch}`);
    console.log(`   Movimientos encontrados: ${stats.movimientosEncontrados}`);
    console.log(`   Movimientos insertados: ${stats.movimientosInsertados}`);
    console.log(`   Duplicados ignorados: ${stats.movimientosDuplicados}`);
    
    res.json({
      success: true,
      ...stats
    });
    
  } catch (error) {
    console.error('❌ Error general:', error.message);
    res.status(500).json({ error: error.message, stats });
  } finally {
    await browser.close();
  }
});

// =============================================
// ENDPOINT: Novedades diarias (para cron)
// =============================================
app.post('/srt/novedades-diarias', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  
  console.log('🔔 Buscando novedades SRT...');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const stats = {
    expedientesSrt: 0,
    expedientesConNovedades: 0,
    expedientesConMatch: 0,
    movimientosInsertados: 0,
    novedades: []
  };
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    await loginAfip(page, usuario, password);
    await navegarAeServicios(page);
    
    const expedientesSrt = await obtenerExpedientes(page);
    stats.expedientesSrt = expedientesSrt.length;
    
    // Filtrar solo con novedades
    const conNovedades = expedientesSrt.filter(e => e.comunicacionesSinLectura > 0);
    stats.expedientesConNovedades = conNovedades.length;
    
    console.log(`📋 ${expedientesSrt.length} expedientes, ${conNovedades.length} con novedades`);
    
    for (const expSrt of conNovedades) {
      const casoInterno = await buscarCasoPorNumeroSrt(expSrt.nro);
      
      if (!casoInterno) {
        console.log(`⚪ Sin match: ${expSrt.nro} - ${expSrt.damnificadoNombre}`);
        continue;
      }
      
      stats.expedientesConMatch++;
      console.log(`🟢 Match: ${expSrt.nro} → caso_srt #${casoInterno.id}`);
      
      try {
        const movimientos = await obtenerMovimientos(page, expSrt.oid);
        
        for (const mov of movimientos) {
          // Verificar si ya existe
          const { data: existe } = await supabase
            .from('movimientos_srt')
            .select('id')
            .eq('caso_srt_id', casoInterno.id)
            .eq('srt_ingreso_oid', mov.ingresoOid)
            .single();
          
          if (!existe) {
            const { error } = await supabase
              .from('movimientos_srt')
              .insert({
                caso_srt_id: casoInterno.id,
                srt_expediente_oid: expSrt.oid,
                srt_expediente_nro: expSrt.nro,
                srt_ingreso_oid: mov.ingresoOid,
                srt_ingreso_nro: mov.ingresoNro,
                fecha: mov.fecha,
                tipo_codigo: mov.tipoCodigo,
                tipo_descripcion: mov.tipoDescripcion,
                damnificado_nombre: expSrt.damnificadoNombre
              });
            
            if (!error) {
              stats.movimientosInsertados++;
              stats.novedades.push({
                caso_srt_id: casoInterno.id,
                nombre_caso: casoInterno.nombre,
                srt_nro: expSrt.nro,
                movimiento: mov.tipoDescripcion,
                fecha: mov.fecha
              });
            }
          }
        }
        
        await new Promise(r => setTimeout(r, 500));
        
      } catch (error) {
        console.error(`❌ Error en ${expSrt.nro}:`, error.message);
      }
    }
    
    console.log(`\n✅ ${stats.movimientosInsertados} nuevos movimientos insertados`);
    
    res.json({
      success: true,
      ...stats
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

// =============================================
// ENDPOINT: Ver movimientos de un caso_srt
// =============================================
app.get('/srt/movimientos/:caso_srt_id', async (req, res) => {
  const { caso_srt_id } = req.params;
  
  const { data, error } = await supabase
    .from('movimientos_srt')
    .select('*')
    .eq('caso_srt_id', caso_srt_id)
    .order('fecha', { ascending: false });
  
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  
  res.json({ success: true, movimientos: data });
});

// =============================================
// ENDPOINT: Test de matching (sin insertar nada)
// =============================================
app.post('/srt/test-matching', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    await loginAfip(page, usuario, password);
    await navegarAeServicios(page);
    const expedientesSrt = await obtenerExpedientes(page);
    
    const resultado = {
      total: expedientesSrt.length,
      conMatch: [],
      sinMatch: []
    };
    
    for (const exp of expedientesSrt) {
      const caso = await buscarCasoPorNumeroSrt(exp.nro);
      
      if (caso) {
        resultado.conMatch.push({
          eservicios: { nro: exp.nro, nombre: exp.damnificadoNombre },
          caso_srt: { id: caso.id, nombre: caso.nombre, numero_srt: caso.numero_srt }
        });
      } else {
        resultado.sinMatch.push({
          nro: exp.nro,
          nombre: exp.damnificadoNombre,
          normalizado: normalizarNumeroSrt(exp.nro)
        });
      }
    }
    
    res.json({
      success: true,
      ...resultado,
      resumen: {
        conMatch: resultado.conMatch.length,
        sinMatch: resultado.sinMatch.length
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

// =============================================
// START SERVER
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SRT Scraper running on port ${PORT}`);
  console.log('📌 Matching: casos_srt.numero_srt');
});
