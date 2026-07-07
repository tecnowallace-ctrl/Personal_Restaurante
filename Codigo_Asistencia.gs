/**
 * PERSONAL MONTANA — CONTROL DE ASISTENCIA
 * =========================================
 * v3: arquitectura basada en CÓDIGO de empleado (E01, E02...) en vez de
 * nombre, para poder renombrar desde el panel de socios sin romper el
 * historial. Agrega también el panel administrador (resumen diario,
 * semanal, mensual, horas extra) y el guardado de fotos en una carpeta
 * fija de Drive.
 *
 * Pestañas requeridas en la Hoja de Google:
 *   - Empleados       (Codigo | Nombre_Visible | PIN | Activo | Cargo)
 *   - Horario_Semanal (Codigo | Lunes | Martes | ... | Domingo)
 *   - Registro        (se llena sola)
 *
 * Ver GUIA_INSTALACION_ASISTENCIA.md para la migración paso a paso.
 */

const NOMBRE_HOJA_EMPLEADOS = "Empleados";
const NOMBRE_HOJA_REGISTRO = "Registro";
const NOMBRE_HOJA_HORARIO = "Horario_Semanal";

const HORA_INICIO_APERTURA = 9;
const HORA_INICIO_CIERRE = 11;
const TOLERANCIA_TARDE_MIN = 10;
const HORAS_PAGAS_POR_TURNO = 7;
const TOPE_HORAS_SEMANALES = 42;

const PICO_INICIO_MIN = 12 * 60 + 30;
const PICO_FIN_MIN = 15 * 60 + 30;

const DIAS_SEMANA = ["Domingo","Lunes","Martes","Miercoles","Jueves","Viernes","Sabado"];
const DIAS_SEMANA_LUN_A_DOM = ["Lunes","Martes","Miercoles","Jueves","Viernes","Sabado","Domingo"];

// ⚠️ Carpeta fija de Drive donde se guardan las fotos de verificación.
const ID_CARPETA_FOTOS = "1IqFp9cmFnFkzaMzhPDbN9RDfaJosg37L";

// ⚠️ CAMBIA ESTE PIN antes de compartir el panel con los socios.
const PIN_PANEL_SOCIOS = "9999";

// ---------------------------------------------------------
// RECARGOS LABORALES (Colombia) — vigentes en 2026
// ⚠️ Estas tasas cambian por ley en fechas específicas.
// Verifica cada año que sigan siendo correctas antes de usarlas
// para nómina real; valida con tu contador antes de pagar con esto.
// ---------------------------------------------------------
const HORA_INICIO_NOCTURNO = 19; // 7:00 p.m. (vigente desde el 25-dic-2025)
const RECARGO_NOCTURNO = 0.35;        // +35% hora ordinaria nocturna
const RECARGO_EXTRA_DIURNA = 0.25;    // +25% hora extra diurna
const RECARGO_EXTRA_NOCTURNA = 0.75;  // +75% hora extra nocturna
const RECARGO_DOMINICAL_FESTIVO = 0.90; // +90% vigente desde jul-2026 (sube a 100% en 2027)
const DIVISOR_HORAS_MES = HORAS_PAGAS_POR_TURNO * 30; // 210 horas/mes con jornada de 7h/día

// ⚠️ Valores oficiales 2026 (Decretos 1469 y 1470 de 2025) — actualizar cada enero.
const SMMLV_2026 = 1750905;
const AUXILIO_TRANSPORTE_2026 = 249095;
const TOPE_SALARIOS_AUXILIO_TRANSPORTE = 2 * SMMLV_2026; // hasta 2 SMMLV tienen derecho

// Festivos de Colombia 2026 (18 nacionales + el nuevo de la Ley 2578/2026).
// ⚠️ ACTUALIZAR ESTA LISTA CADA AÑO — no se calcula automáticamente.
const FESTIVOS_COLOMBIA = [
  "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03",
  "2026-05-01", "2026-05-18", "2026-06-08", "2026-06-15", "2026-06-29",
  "2026-07-13", "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12",
  "2026-11-02", "2026-11-16", "2026-12-08", "2026-12-25"
];

// ---------------------------------------------------------
// GET
// ---------------------------------------------------------
function doGet(e) {
  const accion = e.parameter.accion;

  if (accion === "empleados") {
    const lista = obtenerEmpleadosActivos().map(emp => ({ codigo: emp.codigo, nombre: emp.nombre }));
    return respuestaJson({ empleados: lista });
  }

  if (accion === "verificarPinSocios") {
    return respuestaJson({ valido: String(e.parameter.pin) === PIN_PANEL_SOCIOS });
  }

  if (accion === "resumenAdmin") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) {
      return respuestaJson({ error: "PIN inválido" });
    }
    const mes = e.parameter.mes; // formato "YYYY-MM"
    return respuestaJson(calcularResumenAdmin(mes));
  }

  if (accion === "resumenNomina") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) {
      return respuestaJson({ error: "PIN inválido" });
    }
    const mes = e.parameter.mes;
    return respuestaJson(calcularResumenNomina(mes));
  }

  if (accion === "resumenProvisiones") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) {
      return respuestaJson({ error: "PIN inválido" });
    }
    const mes = e.parameter.mes;
    return respuestaJson(calcularProvisiones(mes));
  }

  return respuestaJson({ error: "Acción no reconocida" });
}

// ---------------------------------------------------------
// POST
// ---------------------------------------------------------
function doPost(e) {
  let datos;
  try {
    datos = JSON.parse(e.postData.contents);
  } catch (err) {
    return respuestaJson({ error: "Cuerpo de solicitud inválido" });
  }

  if (datos.accion === "verificarPin") return manejarVerificarPin(datos);
  if (datos.accion === "registrar") return manejarRegistrar(datos);
  if (datos.accion === "renombrarEmpleado") return manejarRenombrar(datos);

  return respuestaJson({ error: "Acción no reconocida" });
}

// ---------------------------------------------------------
// PIN de empleado (por código)
// ---------------------------------------------------------
function manejarVerificarPin(datos) {
  const empleado = buscarEmpleadoPorCodigo(datos.codigo);
  if (!empleado || String(empleado.pin) !== String(datos.pin)) {
    return respuestaJson({ valido: false });
  }
  const ultimoEvento = obtenerUltimoEventoDeHoy(datos.codigo);
  return respuestaJson({ valido: true, ultimoEvento: ultimoEvento });
}

// ---------------------------------------------------------
// Registrar marcación
// ---------------------------------------------------------
function manejarRegistrar(datos) {
  const empleado = buscarEmpleadoPorCodigo(datos.codigo);
  if (!empleado || String(empleado.pin) !== String(datos.pin)) {
    return respuestaJson({ ok: false, error: "PIN inválido" });
  }

  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const ahora = new Date();
  const zona = Session.getScriptTimeZone();
  const alertas = calcularAlertas(datos.codigo, datos.tipoEvento, ahora);
  const urlFoto = guardarFoto(datos.foto, empleado.nombre, ahora);

  hoja.appendRow([
    ahora,
    Utilities.formatDate(ahora, zona, "yyyy-MM-dd"),
    Utilities.formatDate(ahora, zona, "HH:mm:ss"),
    datos.codigo,
    empleado.nombre,              // nombre "congelado" en el momento del registro
    datos.tipoEvento,
    datos.lat || "",
    datos.lng || "",
    datos.precision || "",
    alertas.observaciones,
    urlFoto
  ]);

  return respuestaJson({ ok: true, alerta: alertas.mensajeParaKiosko });
}

// ---------------------------------------------------------
// Renombrar empleado (solo con PIN de socios)
// ---------------------------------------------------------
function manejarRenombrar(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  const hoja = obtenerHoja(NOMBRE_HOJA_EMPLEADOS);
  const filas = hoja.getDataRange().getValues();
  for (let i = 1; i < filas.length; i++) {
    if (filas[i][0] === datos.codigo) {
      hoja.getRange(i + 1, 2).setValue(datos.nuevoNombre); // columna B = Nombre_Visible
      return respuestaJson({ ok: true });
    }
  }
  return respuestaJson({ ok: false, error: "Código no encontrado" });
}

// ---------------------------------------------------------
// Fotos → carpeta fija de Drive
// ---------------------------------------------------------
function guardarFoto(fotoBase64, nombreEmpleado, ahora) {
  if (!fotoBase64) return "";
  try {
    const base64Limpio = fotoBase64.replace(/^data:image\/\w+;base64,/, "");
    const bytes = Utilities.base64Decode(base64Limpio);
    const zona = Session.getScriptTimeZone();
    const nombreArchivo = nombreEmpleado + "_" + Utilities.formatDate(ahora, zona, "yyyy-MM-dd_HH-mm-ss") + ".jpg";
    const blob = Utilities.newBlob(bytes, "image/jpeg", nombreArchivo);
    const carpeta = DriveApp.getFolderById(ID_CARPETA_FOTOS);
    const archivo = carpeta.createFile(blob);
    return archivo.getUrl();
  } catch (err) {
    return "ERROR_AL_GUARDAR_FOTO";
  }
}

// ---------------------------------------------------------
// Alertas: turno programado + horario pico
// ---------------------------------------------------------
function calcularAlertas(codigo, tipoEvento, ahora) {
  const observaciones = [];
  let mensajeParaKiosko = "";

  const diaSemana = DIAS_SEMANA[ahora.getDay()];
  const turnoProgramado = obtenerTurnoProgramado(codigo, diaSemana);
  const minutosDelDia = ahora.getHours() * 60 + ahora.getMinutes();

  if (tipoEvento === "ENTRADA") {
    if (!turnoProgramado || turnoProgramado === "LIBRE") {
      observaciones.push("FUERA_DE_HORARIO: no tenía turno programado el " + diaSemana);
      mensajeParaKiosko = "Atención: hoy no tenías turno programado. Se avisará al encargado.";
    } else {
      const horaInicioEsperada = turnoProgramado === "APERTURA" ? HORA_INICIO_APERTURA : HORA_INICIO_CIERRE;
      const diferencia = minutosDelDia - horaInicioEsperada * 60;
      if (diferencia > TOLERANCIA_TARDE_MIN) {
        observaciones.push("TARDE: " + diferencia + " min después del inicio de turno (" + turnoProgramado + ")");
        mensajeParaKiosko = "Llegaste " + diferencia + " minutos tarde respecto a tu turno de " + turnoProgramado.toLowerCase() + ".";
      }
    }
  }

  if (tipoEvento === "SALIDA_ALMUERZO") {
    if (minutosDelDia >= PICO_INICIO_MIN && minutosDelDia <= PICO_FIN_MIN) {
      observaciones.push("ALERTA_PICO: salida a almuerzo dentro del horario pico 12:30-15:30");
      mensajeParaKiosko = "Atención: estás saliendo a almuerzo en horario pico (12:30-3:30 p.m.). Esto queda registrado.";
    }
  }

  return { observaciones: observaciones.join(" | "), mensajeParaKiosko: mensajeParaKiosko };
}

function obtenerTurnoProgramado(codigo, diaSemana) {
  const hoja = obtenerHoja(NOMBRE_HOJA_HORARIO);
  const filas = hoja.getDataRange().getValues();
  const encabezados = filas[0];
  const colDia = encabezados.indexOf(diaSemana);
  if (colDia === -1) return null;
  for (let i = 1; i < filas.length; i++) {
    if (filas[i][0] === codigo) {
      const valor = filas[i][colDia];
      return valor ? String(valor).toUpperCase().trim() : "LIBRE";
    }
  }
  return null;
}

function obtenerUltimoEventoDeHoy(codigo) {
  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const filas = hoja.getDataRange().getValues();
  const zona = Session.getScriptTimeZone();
  const hoy = Utilities.formatDate(new Date(), zona, "yyyy-MM-dd");
  let ultimo = null;
  for (let i = 1; i < filas.length; i++) {
    if (filas[i][1] === hoy && filas[i][3] === codigo) {
      ultimo = filas[i][5];
    }
  }
  return ultimo;
}

// ---------------------------------------------------------
// Empleados
// ---------------------------------------------------------
function obtenerEmpleadosActivos() {
  const hoja = obtenerHoja(NOMBRE_HOJA_EMPLEADOS);
  const filas = hoja.getDataRange().getValues();
  const resultado = [];
  for (let i = 1; i < filas.length; i++) {
    const [codigo, nombre, pin, activo, cargo] = filas[i];
    if (codigo && activo === true) {
      resultado.push({ codigo: codigo, nombre: nombre, pin: pin, cargo: cargo });
    }
  }
  return resultado;
}

function buscarEmpleadoPorCodigo(codigo) {
  return obtenerEmpleadosActivos().find(emp => emp.codigo === codigo);
}

function obtenerHoja(nombre) {
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = libro.getSheetByName(nombre);
  if (!hoja) throw new Error("No existe la pestaña '" + nombre + "'.");
  return hoja;
}

function respuestaJson(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// ===========================================================
// PANEL DE SOCIOS — resumen diario / semanal / mensual
// ===========================================================
function calcularResumenAdmin(mesTexto) {
  const zona = Session.getScriptTimeZone();
  const empleados = obtenerEmpleadosActivosConCargo();
  const horarioSemanal = obtenerHorarioSemanalCompleto();

  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const filas = hoja.getDataRange().getValues();

  // eventos[codigo][fecha] = [{tipo, minutos}]
  const eventos = {};
  for (let i = 1; i < filas.length; i++) {
    const fecha = filas[i][1];
    if (!fecha || !String(fecha).startsWith(mesTexto)) continue;
    const codigo = filas[i][3];
    const tipo = filas[i][5];
    const horaStr = filas[i][2];
    const minutos = horaStrAMinutos(horaStr);

    if (!eventos[codigo]) eventos[codigo] = {};
    if (!eventos[codigo][fecha]) eventos[codigo][fecha] = [];
    eventos[codigo][fecha].push({ tipo: tipo, minutos: minutos });
  }

  // diario[fecha][codigo] = {horas, incompleto, turno}
  const diario = {};
  const mensual = {};
  const semanal = {}; // semanal[semanaKey][codigo] = horas

  Object.keys(eventos).forEach(codigo => {
    Object.keys(eventos[codigo]).forEach(fecha => {
      const lista = eventos[codigo][fecha];
      const entrada = lista.find(ev => ev.tipo === "ENTRADA");
      const salida = [...lista].reverse().find(ev => ev.tipo === "SALIDA");
      const salidaAlm = lista.find(ev => ev.tipo === "SALIDA_ALMUERZO");
      const regresoAlm = lista.find(ev => ev.tipo === "REGRESO_ALMUERZO");

      let horas = null;
      let incompleto = true;
      if (entrada && salida) {
        let minutosTrabajados = salida.minutos - entrada.minutos;
        if (salidaAlm && regresoAlm) {
          minutosTrabajados -= (regresoAlm.minutos - salidaAlm.minutos);
        }
        horas = Math.round((minutosTrabajados / 60) * 100) / 100;
        incompleto = false;
      }

      const diaNombre = DIAS_SEMANA_LUN_A_DOM[diaDeSemanaLunesA0(fecha)];
      const turno = (horarioSemanal[codigo] || {})[diaNombre] || "LIBRE";

      if (!diario[fecha]) diario[fecha] = {};
      diario[fecha][codigo] = { horas: horas, incompleto: incompleto, turno: turno };

      if (horas !== null) {
        mensual[codigo] = Math.round(((mensual[codigo] || 0) + horas) * 100) / 100;
        const semanaKey = lunesDeSemana(fecha);
        if (!semanal[semanaKey]) semanal[semanaKey] = {};
        semanal[semanaKey][codigo] = Math.round(((semanal[semanaKey][codigo] || 0) + horas) * 100) / 100;
      }
    });
  });

  return {
    empleados: empleados,
    horarioSemanal: horarioSemanal,
    diario: diario,
    semanal: semanal,
    mensual: mensual,
    topeHorasSemanales: TOPE_HORAS_SEMANALES,
    horasPagasPorTurno: HORAS_PAGAS_POR_TURNO
  };
}

function obtenerEmpleadosActivosConCargo() {
  return obtenerEmpleadosActivos().map(e => ({ codigo: e.codigo, nombre: e.nombre, cargo: e.cargo }));
}

function obtenerHorarioSemanalCompleto() {
  const hoja = obtenerHoja(NOMBRE_HOJA_HORARIO);
  const filas = hoja.getDataRange().getValues();
  const encabezados = filas[0];
  const resultado = {};
  for (let i = 1; i < filas.length; i++) {
    const codigo = filas[i][0];
    if (!codigo) continue;
    resultado[codigo] = {};
    for (let c = 1; c < encabezados.length; c++) {
      resultado[codigo][encabezados[c]] = filas[i][c] ? String(filas[i][c]).toUpperCase().trim() : "LIBRE";
    }
  }
  return resultado;
}

function horaStrAMinutos(horaStr) {
  // horaStr viene como "HH:mm:ss" (texto) o como objeto Date de Sheets
  if (horaStr instanceof Date) {
    return horaStr.getHours() * 60 + horaStr.getMinutes();
  }
  const partes = String(horaStr).split(":");
  return parseInt(partes[0], 10) * 60 + parseInt(partes[1], 10);
}

function diaDeSemanaLunesA0(fechaStr) {
  const d = new Date(fechaStr + "T00:00:00");
  const dow = d.getDay(); // 0=domingo
  return dow === 0 ? 6 : dow - 1; // reindexado: 0=lunes ... 6=domingo
}

function lunesDeSemana(fechaStr) {
  const d = new Date(fechaStr + "T00:00:00");
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// ===========================================================
// RECARGOS Y NÓMINA — base para nómina electrónica
// ===========================================================
// ⚠️ Esta clasificación (diurno/nocturno/extra/dominical-festivo)
// sigue las reglas generales de la legislación laboral colombiana.
// Antes de usarla para pagar nómina real, pídele a tu contador que
// valide las tasas y la lista de festivos del año en curso.

function calcularResumenNomina(mesTexto) {
  const empleados = obtenerEmpleadosActivosConSalario();
  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const filas = hoja.getDataRange().getValues();

  // eventos[codigo][fecha] = { ENTRADA, SALIDA, SALIDA_ALMUERZO, REGRESO_ALMUERZO } (minutos)
  const eventos = {};
  for (let i = 1; i < filas.length; i++) {
    const fecha = filas[i][1];
    if (!fecha || !String(fecha).startsWith(mesTexto)) continue;
    const codigo = filas[i][3];
    const tipo = filas[i][5];
    const minutos = horaStrAMinutos(filas[i][2]);
    if (!eventos[codigo]) eventos[codigo] = {};
    if (!eventos[codigo][fecha]) eventos[codigo][fecha] = {};
    // si hay más de una marca del mismo tipo ese día, se queda con la última (ENTRADA la primera)
    if (tipo === "ENTRADA") {
      if (eventos[codigo][fecha].ENTRADA === undefined) eventos[codigo][fecha].ENTRADA = minutos;
    } else {
      eventos[codigo][fecha][tipo] = minutos;
    }
  }

  const bucketsVacios = () => ({
    diurnoOrd: 0, nocturnoOrd: 0, diurnoExtra: 0, nocturnoExtra: 0,
    festDiurnoOrd: 0, festNocturnoOrd: 0, festDiurnoExtra: 0, festNocturnoExtra: 0
  });

  const resultado = {};
  empleados.forEach(emp => { resultado[emp.codigo] = bucketsVacios(); });

  Object.keys(eventos).forEach(codigo => {
    if (!resultado[codigo]) resultado[codigo] = bucketsVacios();
    Object.keys(eventos[codigo]).forEach(fecha => {
      const ev = eventos[codigo][fecha];
      if (ev.ENTRADA === undefined || ev.SALIDA === undefined) return; // registro incompleto, se omite

      const intervalos = construirIntervalosTrabajo(ev.ENTRADA, ev.SALIDA, ev.SALIDA_ALMUERZO, ev.REGRESO_ALMUERZO);
      const desglose = desglosarMinutosDelDia(intervalos);
      const esFestivo = esFestivoODomingo(fecha);

      const acc = resultado[codigo];
      if (esFestivo) {
        acc.festDiurnoOrd += desglose.diurnoOrd;
        acc.festNocturnoOrd += desglose.nocturnoOrd;
        acc.festDiurnoExtra += desglose.diurnoExtra;
        acc.festNocturnoExtra += desglose.nocturnoExtra;
      } else {
        acc.diurnoOrd += desglose.diurnoOrd;
        acc.nocturnoOrd += desglose.nocturnoOrd;
        acc.diurnoExtra += desglose.diurnoExtra;
        acc.nocturnoExtra += desglose.nocturnoExtra;
      }
    });
  });

  // Redondear a 2 decimales y calcular valor en pesos si hay salario
  const detalle = empleados.map(emp => {
    const h = resultado[emp.codigo];
    Object.keys(h).forEach(k => h[k] = Math.round(h[k] * 100) / 100);

    let valorHora = null;
    let valorTotal = null;
    if (emp.salarioMensual && emp.salarioMensual > 0) {
      valorHora = emp.salarioMensual / DIVISOR_HORAS_MES;
      valorTotal = Math.round(
        h.diurnoOrd * valorHora * 1 +
        h.nocturnoOrd * valorHora * (1 + RECARGO_NOCTURNO) +
        h.diurnoExtra * valorHora * (1 + RECARGO_EXTRA_DIURNA) +
        h.nocturnoExtra * valorHora * (1 + RECARGO_EXTRA_NOCTURNA) +
        h.festDiurnoOrd * valorHora * (1 + RECARGO_DOMINICAL_FESTIVO) +
        h.festNocturnoOrd * valorHora * (1 + RECARGO_DOMINICAL_FESTIVO + RECARGO_NOCTURNO) +
        h.festDiurnoExtra * valorHora * (1 + RECARGO_DOMINICAL_FESTIVO + RECARGO_EXTRA_DIURNA) +
        h.festNocturnoExtra * valorHora * (1 + RECARGO_DOMINICAL_FESTIVO + RECARGO_EXTRA_NOCTURNA)
      );
    }

    return {
      codigo: emp.codigo, nombre: emp.nombre, cargo: emp.cargo,
      horas: h, valorHora: valorHora, valorTotal: valorTotal,
      auxilioTransporte: emp.auxilioTransporte
    };
  });

  return {
    detalle: detalle,
    tasas: {
      recargoNocturno: RECARGO_NOCTURNO,
      extraDiurna: RECARGO_EXTRA_DIURNA,
      extraNocturna: RECARGO_EXTRA_NOCTURNA,
      dominicalFestivo: RECARGO_DOMINICAL_FESTIVO,
      horaInicioNocturno: HORA_INICIO_NOCTURNO,
      divisorHorasMes: DIVISOR_HORAS_MES
    },
    aviso: "Cálculo de referencia. Valida las tasas y festivos con tu contador antes de usar para nómina real."
  };
}

function obtenerEmpleadosActivosConSalario() {
  const hoja = obtenerHoja(NOMBRE_HOJA_EMPLEADOS);
  const filas = hoja.getDataRange().getValues();
  const encabezados = filas[0];
  const colSalario = encabezados.indexOf("Salario_Mensual");
  const colIngreso = encabezados.indexOf("Fecha_Ingreso");
  const resultado = [];
  for (let i = 1; i < filas.length; i++) {
    const [codigo, nombre, pin, activo, cargo] = filas[i];
    if (codigo && activo === true) {
      const salarioMensual = colSalario > -1 ? Number(filas[i][colSalario]) || 0 : 0;
      resultado.push({
        codigo: codigo, nombre: nombre, cargo: cargo,
        salarioMensual: salarioMensual,
        fechaIngreso: colIngreso > -1 ? filas[i][colIngreso] : null,
        auxilioTransporte: (salarioMensual > 0 && salarioMensual <= TOPE_SALARIOS_AUXILIO_TRANSPORTE) ? AUXILIO_TRANSPORTE_2026 : 0
      });
    }
  }
  return resultado;
}

function esFestivoODomingo(fechaStr) {
  const d = new Date(fechaStr + "T00:00:00");
  if (d.getDay() === 0) return true;
  return FESTIVOS_COLOMBIA.indexOf(fechaStr) !== -1;
}

// Construye los tramos de tiempo efectivamente trabajados en el día
// (antes y después del almuerzo, si hubo almuerzo registrado).
function construirIntervalosTrabajo(entradaMin, salidaMin, salidaAlmMin, regresoAlmMin) {
  if (salidaAlmMin !== undefined && regresoAlmMin !== undefined) {
    return [[entradaMin, salidaAlmMin], [regresoAlmMin, salidaMin]];
  }
  return [[entradaMin, salidaMin]];
}

// Reparte los minutos trabajados del día en 4 categorías:
// diurno/nocturno (corte a las 19:00) × ordinario/extra (corte a las 7h acumuladas).
function desglosarMinutosDelDia(intervalos) {
  const TOPE_ORDINARIO_MIN = HORAS_PAGAS_POR_TURNO * 60;
  const CORTE_NOCTURNO_MIN = HORA_INICIO_NOCTURNO * 60;
  let acumuladoOrdinario = 0;
  const resultado = { diurnoOrd: 0, nocturnoOrd: 0, diurnoExtra: 0, nocturnoExtra: 0 };

  intervalos.forEach(([inicio, fin]) => {
    let cursor = inicio;
    while (cursor < fin) {
      const esNocturno = cursor >= CORTE_NOCTURNO_MIN;
      const siguienteCorte = (!esNocturno && CORTE_NOCTURNO_MIN < fin) ? CORTE_NOCTURNO_MIN : fin;
      const duracion = siguienteCorte - cursor;

      let restante = duracion;
      if (acumuladoOrdinario < TOPE_ORDINARIO_MIN) {
        const disponibleOrdinario = TOPE_ORDINARIO_MIN - acumuladoOrdinario;
        const enOrdinario = Math.min(disponibleOrdinario, restante);
        if (esNocturno) resultado.nocturnoOrd += enOrdinario; else resultado.diurnoOrd += enOrdinario;
        acumuladoOrdinario += enOrdinario;
        restante -= enOrdinario;
      }
      if (restante > 0) {
        if (esNocturno) resultado.nocturnoExtra += restante; else resultado.diurnoExtra += restante;
      }
      cursor = siguienteCorte;
    }
  });

  Object.keys(resultado).forEach(k => resultado[k] = resultado[k] / 60); // a horas
  return resultado;
}

// ===========================================================
// PROVISIONES DE PRESTACIONES SOCIALES (vacaciones, prima,
// cesantías, intereses de cesantías)
// ===========================================================
// ⚠️ Esto NO son pagos mensuales — son el valor que se va
// "acumulando" cada mes como pasivo laboral. Se liquidan y pagan
// en momentos distintos: vacaciones y cesantías por año trabajado,
// prima cada semestre. Esta vista es para presupuestar, no para
// incluir en el Reporte DIAN del mes (ese reporta solo lo pagado).
function calcularProvisiones(mesTexto) {
  const empleados = obtenerEmpleadosActivosConSalario();
  const zona = Session.getScriptTimeZone();
  const primerDiaMes = new Date(mesTexto + "-01T00:00:00");
  const ultimoDiaMes = new Date(primerDiaMes.getFullYear(), primerDiaMes.getMonth() + 1, 0);
  const diasDelMes = ultimoDiaMes.getDate();

  const detalle = empleados.map(emp => {
    if (!emp.salarioMensual || emp.salarioMensual <= 0) {
      return { codigo: emp.codigo, nombre: emp.nombre, sinSalario: true };
    }

    // Proporción de días activos dentro del mes, según Fecha_Ingreso
    let diasActivos = diasDelMes;
    if (emp.fechaIngreso instanceof Date) {
      if (emp.fechaIngreso > ultimoDiaMes) {
        diasActivos = 0;
      } else if (emp.fechaIngreso > primerDiaMes) {
        diasActivos = diasDelMes - emp.fechaIngreso.getDate() + 1;
      }
    }
    const proporcion = diasActivos / diasDelMes;

    const provisionVacaciones = Math.round((emp.salarioMensual / 24) * proporcion);
    const provisionPrima = Math.round((emp.salarioMensual / 12) * proporcion);
    const provisionCesantias = Math.round((emp.salarioMensual / 12) * proporcion);
    const provisionInteresCesantias = Math.round(provisionCesantias * 0.12);

    return {
      codigo: emp.codigo, nombre: emp.nombre, sinSalario: false,
      diasActivos: diasActivos, diasDelMes: diasDelMes,
      provisionVacaciones: provisionVacaciones,
      provisionPrima: provisionPrima,
      provisionCesantias: provisionCesantias,
      provisionInteresCesantias: provisionInteresCesantias,
      totalProvisionMes: provisionVacaciones + provisionPrima + provisionCesantias + provisionInteresCesantias
    };
  });

  return {
    detalle: detalle,
    aviso: "Estas son provisiones (pasivo acumulado), no pagos del mes. Vacaciones y cesantías se liquidan por año trabajado, la prima cada semestre. Valida con tu contador antes de usar para estados financieros o liquidaciones reales."
  };
}
