const puppeteer = require('puppeteer');

const SRT_URLS = {
  afipLogin: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml',
  afipPortal: 'https://portalcf.cloud.afip.gob.ar/portal/app/',
  eServicios: 'https://eservicios.srt.gob.ar/home/Servicios.aspx',
  expedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx',
  apiExpedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx/ObtenerExpedientesMedicos',
  apiIngresos: 'https://eservicios.srt.gob.ar/Patrocinio/Ingresos/Ingreso.aspx/ObtenerIngresos',
  apiPdf: 'https://eservicios.srt.gob.ar/Patrocinio/Ingresos/Ingreso.aspx/ObtenerPdfIngreso'
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

async function loginAfip(page, cuit, password) {
  console.log('🔐 Iniciando login en AFIP...');
  
  await page.goto(SRT_URLS.afipLogin, { waitUntil: 'networkidle2', timeout: 60000 });
  
  await page.waitForSelector(AFIP_SELECTORS.inputCuit, { visible: true });
  await page.type(AFIP_SELECTORS.inputCuit, cuit, { delay: 50 });
  await delay(500);
  
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
    page.click(AFIP_SELECTORS.btnSiguiente)
  ]);
  
  await delay(1000);
  
  await page.waitForSelector(AFIP_SELECTORS.inputPassword, { visible: true, timeout: 15000 });
  await delay(500);
  await page.type(AFIP_SELECTORS.inputPassword, password, { delay: 50 });
  await delay(500);
  
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
    page.click(AFIP_SELECTORS.btnIngresar)
  ]);
  
  await delay(2000);
  
  const currentUrl = page.url();
  if (currentUrl.includes('portalcf.cloud.afip.gob.ar')) {
    console.log('✅ Login AFIP exitoso');
    return true;
  }
  
  if (currentUrl.includes('auth.afip.gob.ar')) {
    const errorMsg = await page.$eval('.text-danger, .error, .alert-danger', el => el.textContent).catch(() => null);
    if (errorMsg) {
      throw new Error('Login AFIP falló: ' + errorMsg);
    }
  }
  
  throw new Error('Login AFIP falló - URL inesperada: ' + currentUrl);
}

async function navegarAeServicios(page) {
  console.log('🔄 Navegando a e-Servicios SRT...');
  
  // Buscar y clickear el link de e-Servicios SRT en el portal AFIP
  await delay(2000);
  
  // Buscar el link que contiene "e-Servicios SRT"
  const clicked = await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.textContent.includes('e-Servicios SRT') || link.textContent.includes('e-Servicios S.R.T')) {
        link.click();
        return true;
      }
    }
    // Buscar en h3 o divs
    const elements = document.querySelectorAll('h3, div, span');
    for (const el of elements) {
      if (el.textContent.includes('e-Servicios SRT')) {
        const parent = el.closest('a') || el.closest('[onclick]') || el.closest('button');
        if (parent) {
          parent.click();
          return true;
        }
        el.click();
        return true;
      }
    }
    return false;
  });
  
  if (clicked) {
    console.log('📍 Click en e-Servicios SRT');
    await delay(3000);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  } else {
    console.log('⚠️ No encontré link e-Servicios SRT, yendo directo...');
  }
  
  await delay(2000);
  console.log('📍 URL actual:', page.url());
  
  // Si no estamos en SRT, ir directo
  if (!page.url().includes('srt.gob.ar')) {
    await page.goto(SRT_URLS.eServicios, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);
  }
  
  // Navegar a expedientes
  await page.goto(SRT_URLS.expedientes, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('📍 En expedientes:', page.url());
  
  await delay(2000);
  
  console.log('✅ Navegación completada');
  return true;
}

async function obtenerExpedientes(page) {
  console.log('📋 Obteniendo lista de expedientes...');
  console.log('📍 URL actual:', page.url());
  
  const response = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ numExpdte: null, numAnio: null })
      });
      const text = await res.text();
      try {
        return { ok: true, data: JSON.parse(text) };
      } catch (e) {
        return { ok: false, text: text.substring(0, 500), status: res.status };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, SRT_URLS.apiExpedientes);
  
  console.log('📦 Response:', JSON.stringify(response).substring(0, 200));
  
  if (!response.ok) {
    console.log('⚠️ Error en API:', response.error || response.text);
    return [];
  }
  
  if (!response.data.d) {
    console.log('⚠️ Respuesta sin datos');
    return [];
  }
  
  const expedientes = response.data.d.map(exp => ({
    oid: exp.OID,
    nro: exp.Nro,
    motivo: exp.Motivo,
    damnificadoCuil: exp.Damnificado?.Cuil,
    damnificadoNombre: exp.Damnificado?.Nombre,
    fechaInicio: parseDotNetDate(exp.Inicio),
    comunicacionesSinLectura: exp.ComunicacionessinLectura || 0,
    fechaUltComunicacion: parseDotNetDate(exp.FechaUltComunicacionsinLeer),
    fueVisto: exp.FueVisto,
    generarIngreso: exp.GenerarIngreso,
    imprimible: exp.Imprimible
  }));
  
  console.log('✅ ' + expedientes.length + ' expedientes encontrados');
  return expedientes;
}

async function obtenerMovimientos(page, expedienteOid) {
  const response = await page.evaluate(async (url, oid) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ idExpediente: oid })
    });
    return res.json();
  }, SRT_URLS.apiIngresos, expedienteOid);
  
  if (!response.d) return [];
  
  return response.d.map(mov => ({
    expedienteOid: mov.Ingreso.IdExpediente,
    ingresoOid: mov.Ingreso.OID,
    ingresoNro: mov.Ingreso.NroIngreso,
    numero: mov.Ingreso.Numero,
    anio: mov.Ingreso.Anio,
    fecha: parseDotNetDate(mov.Ingreso.FechaInsert),
    tipoCodigo: mov.Tipo?.valor,
    tipoDescripcion: mov.Tipo?.nombre,
    persistencia: mov.Ingreso.Persistencia
  }));
}

async function descargarPdf(page, ingresoOid) {
  const response = await page.evaluate(async (url, oid) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ OID: oid })
    });
    return res.json();
  }, SRT_URLS.apiPdf, ingresoOid);
  
  return response.d;
}

module.exports = {
  loginAfip,
  navegarAeServicios,
  obtenerExpedientes,
  obtenerMovimientos,
  descargarPdf,
  parseDotNetDate,
  SRT_URLS,
  AFIP_SELECTORS
};
