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
  
  // Ir directo a e-Servicios, va a redirigir a AFIP para login
  await page.goto(SRT_URLS.eServiciosHome, { waitUntil: 'networkidle2', timeout: 60000 });
  
  console.log('📍 URL:', page.url());
  
  // Si redirigió a AFIP, hacer login
  if (page.url().includes('afip.gob.ar')) {
    console.log('📍 En AFIP, haciendo login...');
    
    // Ingresar CUIT
    await page.waitForSelector(AFIP_SELECTORS.inputCuit, { visible: true, timeout: 10000 });
    await page.type(AFIP_SELECTORS.inputCuit, cuit, { delay: 50 });
    await delay(500);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
      page.click(AFIP_SELECTORS.btnSiguiente)
    ]);
    
    await delay(1000);
    
    // Ingresar password
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
  
  // Debería estar en e-Servicios SRT ahora
  if (page.url().includes('srt.gob.ar')) {
    console.log('✅ Login exitoso, en e-Servicios SRT');
    
    // Ir a expedientes
    await page.goto(SRT_URLS.expedientes, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('📍 URL expedientes:', page.url());
    
    await delay(2000);
    
    return !page.url().includes('ErrorValidate');
  }
  
  console.log('❌ No llegamos a SRT');
  return false;
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
  loginYNavegarSRT,
  obtenerExpedientes,
  obtenerMovimientos,
  parseDotNetDate,
  SRT_URLS
};
