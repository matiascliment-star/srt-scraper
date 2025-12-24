const puppeteer = require('puppeteer');

const SRT_URLS = {
  eServiciosHome: 'https://eservicios.srt.gob.ar/home/Servicios.aspx',
  expedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx',
  apiExpedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx/ObtenerExpedientesMedicos',
  apiIngresos: 'https://eservicios.srt.gob.ar/Patrocinio/Ingresos/Ingreso.aspx/ObtenerIngresos'
};

const AFIP_SELECTORS = {
  inputCuit: '#F1\\:username',
  btnSiguiente: '#F1\\:btnSiguiente',
  inputPassword: '#F1\\:password',
  btnIngresar: '#F1\\:btnIngresar'
};

function parseDotNetDate(dotNetDate) {
  if (!dotNetDate) return null;
  const match = dotNetDate.match(/\/Date\((\d+)\)\//);
  return match ? new Date(parseInt(match[1])) : null;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loginYNavegarSRT(page, cuit, password) {
  console.log('🔐 Yendo directo a e-Servicios SRT...');
  
  await page.goto(SRT_URLS.eServiciosHome, { waitUntil: 'networkidle2', timeout: 60000 });
  
  console.log('📍 URL:', page.url());
  
  if (page.url().includes('afip.gob.ar')) {
    console.log('📍 En AFIP, haciendo login...');
    
    await page.waitForSelector(AFIP_SELECTORS.inputCuit, { visible: true, timeout: 10000 });
    await page.type(AFIP_SELECTORS.inputCuit, cuit, { delay: 50 });
    await delay(500);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
      page.click(AFIP_SELECTORS.btnSiguiente)
    ]);
    
    await delay(1000);
    
    await page.waitForSelector(AFIP_SELECTORS.inputPassword, { visible: true, timeout: 10000 });
    await page.type(AFIP_SELECTORS.inputPassword, password, { delay: 50 });
    await delay(500);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click(AFIP_SELECTORS.btnIngresar)
    ]);
    
    await delay(3000);
  }
  
  console.log('📍 Después de login:', page.url());
  
  if (!page.url().includes('srt.gob.ar')) {
    console.log('❌ No llegamos a SRT');
    return false;
  }
  
  console.log('✅ En e-Servicios SRT');
  
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(1000);
  
  console.log('📍 Buscando Patrocinio Letrado...');
  
  const clickedVerOpciones = await page.evaluate(() => {
    const cards = document.querySelectorAll('h5, h4, h3, .card-title, div');
    for (const card of cards) {
      if (card.innerText && card.innerText.includes('Patrocinio Letrado')) {
        const parent = card.closest('.card, .panel, section, div[class*="card"], div[class*="panel"]') || card.parentElement.parentElement;
        if (parent) {
          const btn = parent.querySelector('button, a');
          if (btn && btn.innerText.includes('VER OPCIONES')) {
            btn.click();
            return { found: true, text: 'VER OPCIONES' };
          }
          const anyBtn = parent.querySelector('button, a.btn, [role="button"]');
          if (anyBtn) {
            anyBtn.click();
            return { found: true, text: anyBtn.innerText };
          }
        }
      }
    }
    
    const allButtons = document.querySelectorAll('button, a.btn');
    for (const btn of allButtons) {
      const rect = btn.getBoundingClientRect();
      if (btn.innerText.includes('VER OPCIONES') && rect.top > 400) {
        btn.scrollIntoView();
        btn.click();
        return { found: true, text: 'VER OPCIONES plan B' };
      }
    }
    
    return { found: false };
  });
  
  console.log('📍 Click VER OPCIONES:', JSON.stringify(clickedVerOpciones));
  
  await delay(2000);
  
  const clickedExpedientes = await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.innerText.includes('Expedientes') || link.href.includes('Expedientes')) {
        link.click();
        return { found: true, text: link.innerText, href: link.href };
      }
    }
    return { found: false };
  });
  
  console.log('📍 Click Expedientes:', JSON.stringify(clickedExpedientes));
  
  if (clickedExpedientes.found) {
    await delay(2000);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  }
  
  console.log('📍 URL final:', page.url());
  await delay(2000);
  
  return page.url().includes('Expedientes') && !page.url().includes('ErrorValidate');
}

async function obtenerExpedientes(page) {
  console.log('📋 Obteniendo expedientes...');
  console.log('📍 URL:', page.url());
  
  if (page.url().includes('ErrorValidate') || !page.url().includes('Expedientes')) {
    console.log('❌ Sesión no válida');
    return [];
  }
  
  const response = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ numExpdte: null, numAnio: null })
      });
      return { status: res.status, data: await res.json() };
    } catch (e) {
      return { error: e.message };
    }
  }, SRT_URLS.apiExpedientes);
  
  if (response.error || !response.data?.d) {
    console.log('⚠️ Error:', response.error);
    return [];
  }
  
  console.log('✅ ' + response.data.d.length + ' expedientes');
  
  return response.data.d.map(exp => ({
    oid: exp.OID,
    nro: exp.Nro,
    motivo: exp.Motivo,
    damnificadoCuil: exp.Damnificado?.Cuil,
    damnificadoNombre: exp.Damnificado?.Nombre,
    fechaInicio: parseDotNetDate(exp.Inicio),
    comunicacionesSinLectura: exp.ComunicacionessinLectura || 0,
    fechaUltComunicacion: parseDotNetDate(exp.FechaUltComunicacionsinLeer)
  }));
}

async function obtenerMovimientos(page, expedienteOid) {
  console.log('📥 Obteniendo movimientos para OID:', expedienteOid);
  
  const response = await page.evaluate(async (url, oid) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ idExpediente: oid })
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      return { error: e.message };
    }
  }, SRT_URLS.apiIngresos, expedienteOid);
  
  if (response.error) {
    console.log('❌ Error movimientos:', response.error);
    return [];
  }
  
  try {
    const data = JSON.parse(response.text);
    if (!data.d || data.d.length === 0) {
      console.log('📭 Sin movimientos');
      return [];
    }
    
    // LOG COMPLETO DEL PRIMER MOVIMIENTO
    console.log('📦 ESTRUCTURA MOVIMIENTO:', JSON.stringify(data.d[0], null, 2));
    
    console.log('✅ ' + data.d.length + ' movimientos');
    
    return data.d.map(mov => ({
      expedienteOid: mov.Ingreso?.IdExpediente,
      ingresoOid: mov.Ingreso?.OID,
      ingresoNro: mov.Ingreso?.NroIngreso,
      fecha: parseDotNetDate(mov.Ingreso?.FechaInsert),
      tipoCodigo: mov.Tipo?.valor,
      tipoDescripcion: mov.Tipo?.nombre
    }));
  } catch (e) {
    console.log('❌ Parse error:', e.message, 'Response:', response.text?.substring(0, 200));
    return [];
  }
}

module.exports = {
  loginYNavegarSRT,
  obtenerExpedientes,
  obtenerMovimientos,
  parseDotNetDate,
  SRT_URLS
};
