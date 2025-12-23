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

// Selectores del login AFIP (escapar los ":" para CSS)
const AFIP_SELECTORS = {
  inputCuit: '#F1\\:username',
  btnSiguiente: '#F1\\:btnSiguiente',
  inputPassword: '#F1\\:password',
  btnIngresar: '#F1\\:btnIngresar'
};

// Parsear fecha .NET (/Date(timestamp)/)
function parseDotNetDate(dotNetDate) {
  if (!dotNetDate) return null;
  const match = dotNetDate.match(/\/Date\((\d+)\)\//);
  return match ? new Date(parseInt(match[1])) : null;
}

// Delay helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Login en AFIP con Clave Fiscal
async function loginAfip(page, cuit, password) {
  console.log('🔐 Iniciando login en AFIP...');
  
  await page.goto(SRT_URLS.afipLogin, { waitUntil: 'networkidle2', timeout: 60000 });
  
  // Paso 1: Ingresar CUIT
  await page.waitForSelector(AFIP_SELECTORS.inputCuit, { visible: true });
  await page.type(AFIP_SELECTORS.inputCuit, cuit, { delay: 50 });
  await delay(500);
  await page.click(AFIP_SELECTORS.btnSiguiente);
  
  // Paso 2: Esperar campo password e ingresar
  await page.waitForSelector(AFIP_SELECTORS.inputPassword, { visible: true, timeout: 10000 });
  await delay(500);
  await page.type(AFIP_SELECTORS.inputPassword, password, { delay: 50 });
  await delay(500);
  await page.click(AFIP_SELECTORS.btnIngresar);
  
  // Esperar redirección al portal
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  
  // Verificar que llegamos al portal
  const currentUrl = page.url();
  if (currentUrl.includes('portalcf.cloud.afip.gob.ar')) {
    console.log('✅ Login AFIP exitoso');
    return true;
  }
  
  throw new Error('Login AFIP falló - URL inesperada: ' + currentUrl);
}

// Navegar desde portal AFIP a e-Servicios SRT
async function navegarAeServicios(page) {
  console.log('🔄 Navegando a e-Servicios SRT...');
  
  // Buscar el link/botón de e-Servicios SRT en el portal
  // Puede ser un link directo o un botón en la grilla de servicios
  const srtLinkSelectors = [
    'a[href*="eservicios.srt.gob.ar"]',
    'a:has-text("e-Servicios SRT")',
    'div:has-text("e-Servicios SRT")',
    '.panel-body:has-text("e-Servicios SRT")'
  ];
  
  let clicked = false;
  for (const selector of srtLinkSelectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        await element.click();
        clicked = true;
        break;
      }
    } catch (e) {
      continue;
    }
  }
  
  if (!clicked) {
    // Buscar por texto visible
    const links = await page.$$('a');
    for (const link of links) {
      const text = await link.evaluate(el => el.textContent);
      if (text && text.includes('e-Servicios SRT')) {
        await link.click();
        clicked = true;
        break;
      }
    }
  }
  
  if (!clicked) {
    // Ir directo si ya tenemos cookies de sesión
    console.log('⚠️ No encontré link a SRT, navegando directo...');
    await page.goto(SRT_URLS.eServicios, { waitUntil: 'networkidle2' });
  } else {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  }
  
  // Navegar a la sección de Patrocinante > Expedientes
  await delay(1000);
  await page.goto(SRT_URLS.expedientes, { waitUntil: 'networkidle2', timeout: 30000 });
  
  console.log('✅ En página de expedientes SRT');
  return true;
}

// Obtener lista de expedientes via API JSON
async function obtenerExpedientes(page) {
  console.log('📋 Obteniendo lista de expedientes...');
  
  const response = await page.evaluate(async (url) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ numExpdte: null, numAnio: null })
    });
    return res.json();
  }, SRT_URLS.apiExpedientes);
  
  if (!response.d) {
    console.log('⚠️ Respuesta inesperada:', response);
    return [];
  }
  
  const expedientes = response.d.map(exp => ({
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
  
  console.log(`✅ ${expedientes.length} expedientes encontrados`);
  return expedientes;
}

// Obtener movimientos/ingresos de un expediente
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

// Descargar PDF de un movimiento (retorna base64)
async function descargarPdf(page, ingresoOid) {
  const response = await page.evaluate(async (url, oid) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ OID: oid })
    });
    return res.json();
  }, SRT_URLS.apiPdf, ingresoOid);
  
  return response.d; // Base64 string del PDF
}

// Función principal: obtener todos los expedientes con sus movimientos
async function obtenerTodosLosMovimientos(cuit, password, options = {}) {
  const { 
    headless = true,
    soloConNovedades = false,
    expedienteIds = null,
    delayEntreExpedientes = 500
  } = options;
  
  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const resultados = {
    success: false,
    expedientes: [],
    movimientos: [],
    errores: []
  };
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // 1. Login AFIP
    await loginAfip(page, cuit, password);
    
    // 2. Navegar a e-Servicios SRT
    await navegarAeServicios(page);
    
    // 3. Obtener expedientes
    const expedientes = await obtenerExpedientes(page);
    resultados.expedientes = expedientes;
    
    // 4. Obtener movimientos de cada expediente
    for (const exp of expedientes) {
      // Filtrar por IDs si se especificaron
      if (expedienteIds && !expedienteIds.includes(exp.oid)) continue;
      
      // Solo con novedades si se especificó
      if (soloConNovedades && exp.comunicacionesSinLectura === 0) continue;
      
      try {
        console.log(`📂 Obteniendo movimientos de ${exp.nro} (${exp.damnificadoNombre})...`);
        const movimientos = await obtenerMovimientos(page, exp.oid);
        
        for (const mov of movimientos) {
          resultados.movimientos.push({
            ...mov,
            expedienteNro: exp.nro,
            damnificadoCuil: exp.damnificadoCuil,
            damnificadoNombre: exp.damnificadoNombre
          });
        }
        
        await delay(delayEntreExpedientes);
      } catch (error) {
        console.error(`❌ Error en expediente ${exp.nro}:`, error.message);
        resultados.errores.push({ expediente: exp.nro, error: error.message });
      }
    }
    
    resultados.success = true;
    console.log(`✅ Completado: ${resultados.expedientes.length} expedientes, ${resultados.movimientos.length} movimientos`);
    
  } catch (error) {
    console.error('❌ Error general:', error.message);
    resultados.errores.push({ general: error.message });
  } finally {
    await browser.close();
  }
  
  return resultados;
}

// Función para obtener solo novedades (expedientes con comunicaciones sin leer)
async function obtenerNovedadesSrt(cuit, password) {
  return obtenerTodosLosMovimientos(cuit, password, { soloConNovedades: true });
}

module.exports = {
  loginAfip,
  navegarAeServicios,
  obtenerExpedientes,
  obtenerMovimientos,
  descargarPdf,
  obtenerTodosLosMovimientos,
  obtenerNovedadesSrt,
  parseDotNetDate,
  SRT_URLS,
  AFIP_SELECTORS
};
