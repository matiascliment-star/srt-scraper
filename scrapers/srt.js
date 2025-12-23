const puppeteer = require('puppeteer');

const SRT_URLS = {
  afipLogin: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml',
  misServicios: 'https://portalcf.cloud.afip.gob.ar/portal/app/mis-servicios',
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

async function navegarAeServicios(page, browser) {
  console.log('🔄 Navegando a e-Servicios SRT...');
  
  // Paso 1: Ir a mis-servicios
  await page.goto(SRT_URLS.misServicios, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  console.log('📍 En mis-servicios');
  
  // Scroll hasta abajo
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(1000);
  
  console.log('📍 Scroll hecho, buscando SRT...');
  
  // Preparar para capturar nueva pestaña
  const newPagePromise = new Promise(resolve => {
    browser.once('targetcreated', async target => {
      const newPage = await target.page();
      if (newPage) {
        resolve(newPage);
      }
    });
  });
  
  // Buscar y clickear E-SERVICIOS SRT
  const clicked = await page.evaluate(() => {
    const allElements = document.querySelectorAll('a, div[role="button"], .panel, .panel-default');
    
    for (const el of allElements) {
      const text = el.innerText.toUpperCase();
      if (text.includes('E-SERVICIOS SRT') || 
          (text.includes('SRT') && text.includes('VENTANILLA'))) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.click();
        return { found: true, text: el.innerText.substring(0, 60) };
      }
    }
    return { found: false };
  });
  
  console.log('📍 Click result:', JSON.stringify(clicked));
  
  if (!clicked.found) {
    console.log('❌ No encontré link SRT');
    return { page, success: false };
  }
  
  // Esperar nueva pestaña o navegación
  console.log('📍 Esperando nueva pestaña...');
  
  const newPage = await Promise.race([
    newPagePromise,
    delay(8000).then(() => null)
  ]);
  
  if (newPage) {
    console.log('📍 Nueva pestaña detectada!');
    await newPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await delay(2000);
    console.log('📍 URL nueva pestaña:', newPage.url());
    
    // Ir a expedientes en la nueva pestaña
    if (newPage.url().includes('srt.gob.ar')) {
      await newPage.goto(SRT_URLS.expedientes, { waitUntil: 'networkidle2', timeout: 30000 });
      console.log('📍 URL expedientes:', newPage.url());
    }
    
    return { page: newPage, success: !newPage.url().includes('ErrorValidate') };
  }
  
  // Si no hay nueva pestaña, verificar si navegó en la misma
  console.log('📍 No hubo nueva pestaña, verificando navegación...');
  await delay(3000);
  console.log('📍 URL actual:', page.url());
  
  if (page.url().includes('srt.gob.ar')) {
    await page.goto(SRT_URLS.expedientes, { waitUntil: 'networkidle2', timeout: 30000 });
  }
  
  return { page, success: page.url().includes('srt.gob.ar') };
}

async function obtenerExpedientes(page) {
  console.log('📋 Obteniendo expedientes...');
  console.log('📍 URL:', page.url());
  
  if (page.url().includes('ErrorValidate') || !page.url().includes('srt.gob.ar')) {
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
