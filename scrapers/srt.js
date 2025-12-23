const puppeteer = require('puppeteer');

const SRT_URLS = {
  afipLogin: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml',
  afipPortal: 'https://portalcf.cloud.afip.gob.ar/portal/app/',
  misServicios: 'https://portalcf.cloud.afip.gob.ar/portal/app/mis-servicios',
  eServicios: 'https://eservicios.srt.gob.ar/home/Servicios.aspx',
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
  
  throw new Error('Login AFIP falló - URL: ' + currentUrl);
}

async function navegarAeServicios(page) {
  console.log('🔄 Navegando a e-Servicios SRT...');
  
  // Paso 1: Click en "Ver todos"
  console.log('📍 Clickeando Ver todos...');
  await page.goto(SRT_URLS.misServicios, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  console.log('📍 En mis-servicios:', page.url());
  
  // Paso 2: Click en "E-SERVICIOS SRT"
  console.log('📍 Buscando E-SERVICIOS SRT...');
  
  const srtLink = await page.$('a[title="srt eservicios"]');
  if (srtLink) {
    console.log('📍 Encontrado por title, clickeando...');
    await srtLink.click();
  } else {
    // Fallback: buscar por texto
    const clicked = await page.evaluate(() => {
      const links = document.querySelectorAll('a.panel');
      for (const link of links) {
        if (link.innerText.includes('E-SERVICIOS SRT') || link.innerText.includes('SERVICIOS SRT')) {
          link.click();
          return true;
        }
      }
      return false;
    });
    
    if (!clicked) {
      console.log('⚠️ No encontré link SRT');
    }
  }
  
  await delay(3000);
  
  // Esperar que cargue e-Servicios o se abra nueva pestaña
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  
  console.log('📍 URL después de click SRT:', page.url());
  
  // Si estamos en eservicios.srt.gob.ar, ir a expedientes
  if (page.url().includes('srt.gob.ar')) {
    await page.goto(SRT_URLS.expedientes, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('📍 URL expedientes:', page.url());
  }
  
  await delay(2000);
  
  return !page.url().includes('ErrorValidate');
}

async function obtenerExpedientes(page) {
  console.log('📋 Obteniendo lista de expedientes...');
  console.log('📍 URL:', page.url());
  
  if (page.url().includes('ErrorValidate')) {
    console.log('❌ Sesión SRT no válida');
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
    console.log('⚠️ Error o sin datos:', response.error);
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
    fecha: parseDotNetDate(mov.Ingreso.FechaInsert),
    tipoCodigo: mov.Tipo?.valor,
    tipoDescripcion: mov.Tipo?.nombre
  }));
}

module.exports = {
  loginAfip,
  navegarAeServicios,
  obtenerExpedientes,
  obtenerMovimientos,
  parseDotNetDate,
  SRT_URLS
};
