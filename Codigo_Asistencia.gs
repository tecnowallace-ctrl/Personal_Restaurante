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
const NOMBRE_HOJA_EXCEPCIONES = "Excepciones_Horario";
const NOMBRE_HOJA_HISTORIAL = "Historial_Nomina";

const HORA_INICIO_APERTURA = 9;   // 9:00 a.m. → sale 5:00 p.m.
const HORA_INICIO_MEDIO = 10;     // 10:00 a.m. → sale 6:00 p.m.
const HORA_INICIO_CIERRE = 11;    // 11:00 a.m. → sale 7:00 p.m.
const TOLERANCIA_TARDE_MIN = 10;

// Límites legales de horas extra (Art. 22 CST) — esto SÍ es una violación,
// distinto de simplemente superar la jornada ordinaria (lo cual solo implica
// que hay que pagar recargo/extra, no que sea ilegal).
const LIMITE_EXTRA_DIARIA_HORAS = 2;
const LIMITE_EXTRA_SEMANAL_HORAS = 12;

function horaInicioTurno(turno) {
  if (turno === "APERTURA") return HORA_INICIO_APERTURA;
  if (turno === "MEDIO") return HORA_INICIO_MEDIO;
  if (turno === "CIERRE") return HORA_INICIO_CIERRE;
  return null;
}
const HORAS_PAGAS_POR_TURNO = 7;

// ⚠️ La jornada máxima semanal en Colombia baja por fases (Ley 2101 de 2021).
// Este valor representa el tope vigente HOY; para meses históricos, el
// cálculo real por semana usa topeHorasVigente(fecha) más abajo.
const TOPE_HORAS_SEMANALES = topeHorasVigente(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"));

// Devuelve el tope legal de horas semanales vigente en una fecha dada,
// según el cronograma de reducción de jornada de la Ley 2101 de 2021.
// ⚠️ Revisar esta función si el Congreso modifica el cronograma.
function topeHorasVigente(fechaTexto) {
  const fecha = new Date(fechaTexto + "T00:00:00");
  if (fecha < new Date("2023-07-16T00:00:00")) return 48;
  if (fecha < new Date("2024-07-16T00:00:00")) return 47;
  if (fecha < new Date("2025-07-16T00:00:00")) return 46;
  if (fecha < new Date("2026-07-16T00:00:00")) return 44;
  return 42;
}

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
const DIVISOR_HORAS_QUINCENA = DIVISOR_HORAS_MES / 2;  // 105 horas — el sueldo quincenal siempre es la mitad, sin importar si son 15 o 16 días

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

  if (accion === "resumenNominaQuincena") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) {
      return respuestaJson({ error: "PIN inválido" });
    }
    const mes = e.parameter.mes;
    const quincena = e.parameter.quincena; // "1" o "2"
    const ultimoDia = new Date(Number(mes.slice(0,4)), Number(mes.slice(5,7)), 0).getDate();
    const fechaInicio = quincena === "1" ? (mes + "-01") : (mes + "-16");
    const fechaFin = quincena === "1" ? (mes + "-15") : (mes + "-" + String(ultimoDia).padStart(2,"0"));
    return respuestaJson(calcularResumenNomina(mes, fechaInicio, fechaFin, DIVISOR_HORAS_QUINCENA));
  }

  if (accion === "historialNomina") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) {
      return respuestaJson({ error: "PIN inválido" });
    }
    return respuestaJson(obtenerHistorialNomina());
  }

  if (accion === "bitacoraDia") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) {
      return respuestaJson({ error: "PIN inválido" });
    }
    const fecha = e.parameter.fecha; // "YYYY-MM-DD"
    return respuestaJson(calcularBitacoraDia(fecha));
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
  if (datos.accion === "actualizarHorario") return manejarActualizarHorario(datos);
  if (datos.accion === "ajustarHora") return manejarAjustarHora(datos);
  if (datos.accion === "guardarExcepcion") return manejarGuardarExcepcion(datos);
  if (datos.accion === "cerrarPeriodoNomina") return manejarCerrarPeriodoNomina(datos);

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
// Corrección manual de una hora de entrada/salida.
// Nunca modifica ni borra la marca original — agrega una fila
// nueva marcada como "AJUSTE_MANUAL", que tiene prioridad al
// calcular horas (ver construirEventosPorDia). Así el registro
// original queda intacto para auditoría, y el ajuste queda
// documentado con quién lo hizo y cuándo.
// ---------------------------------------------------------
// ---------------------------------------------------------
// Guarda un horario especial (excepción) para un código+fecha
// específicos — por ejemplo, alguien que va a entrar más temprano
// o salir más tarde un día puntual por necesidad del turno.
// No toca Horario_Semanal (que es el patrón recurrente); esto vive
// aparte, en la pestaña Excepciones_Horario, y se muestra con un
// color distinto en la pestaña Día del panel.
// ---------------------------------------------------------
function manejarGuardarExcepcion(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha)) {
    return respuestaJson({ ok: false, error: "Fecha inválida, debe ser AAAA-MM-DD" });
  }
  if (!/^\d{2}:\d{2}$/.test(datos.horaEntrada) || !/^\d{2}:\d{2}$/.test(datos.horaSalida)) {
    return respuestaJson({ ok: false, error: "Hora inválida, debe ser HH:mm" });
  }
  const empleado = buscarEmpleadoPorCodigo(datos.codigo);
  if (!empleado) {
    return respuestaJson({ ok: false, error: "Código no encontrado" });
  }

  let hoja = obtenerHojaOpcional(NOMBRE_HOJA_EXCEPCIONES);
  if (!hoja) {
    const libro = SpreadsheetApp.getActiveSpreadsheet();
    hoja = libro.insertSheet(NOMBRE_HOJA_EXCEPCIONES);
    hoja.appendRow(["Codigo", "Fecha", "Hora_Entrada", "Hora_Salida", "Motivo"]);
  }

  hoja.appendRow([datos.codigo, datos.fecha, datos.horaEntrada, datos.horaSalida, datos.motivo || ""]);
  return respuestaJson({ ok: true });
}

// ---------------------------------------------------------
// Cierra un período de nómina (mes o quincena) y guarda una
// "foto" fija de las cifras calculadas ese día — sueldo, horas
// extra, recargos, deducciones y neto de cada persona. Una vez
// guardado, ese registro ya NO cambia aunque después edites
// salarios, corrijas horas o cambies tasas — así queda un
// respaldo real de lo que efectivamente se pagó cada período.
//
// El cálculo detallado (desglose por concepto) se hace en el
// panel (mismo que ves en el Desprendible) y se envía ya listo
// para guardar — este endpoint solo valida y lo escribe.
// ---------------------------------------------------------
function manejarCerrarPeriodoNomina(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  if (!Array.isArray(datos.registros) || datos.registros.length === 0) {
    return respuestaJson({ ok: false, error: "No hay registros para guardar" });
  }
  if (!datos.periodoEtiqueta || !datos.periodoInicio || !datos.periodoFin) {
    return respuestaJson({ ok: false, error: "Falta identificar el período (etiqueta, inicio, fin)" });
  }

  let hoja = obtenerHojaOpcional(NOMBRE_HOJA_HISTORIAL);
  if (!hoja) {
    const libro = SpreadsheetApp.getActiveSpreadsheet();
    hoja = libro.insertSheet(NOMBRE_HOJA_HISTORIAL);
    hoja.appendRow([
      "Fecha_Cierre", "Periodo", "Periodo_Inicio", "Periodo_Fin", "Codigo", "Nombre", "Cargo",
      "Sueldo_Basico", "Auxilio_Transporte", "HED", "HEN", "Recargo_Nocturno",
      "Recargo_DomFest_Diurno", "Recargo_DomFest_Nocturno", "HED_DomFest", "HEN_DomFest",
      "Total_Devengado", "Salud", "Pension", "Total_Deducido", "Neto_Pagado"
    ]);
  }

  // Evita cerrar el mismo período dos veces para la misma persona sin darse cuenta.
  const yaExiste = verificarPeriodoYaCerrado(hoja, datos.periodoEtiqueta);
  if (yaExiste && !datos.confirmarReemplazo) {
    return respuestaJson({ ok: false, yaExiste: true, error: "Este período ya fue cerrado antes. Confirma si quieres guardar una nueva versión." });
  }

  const ahora = new Date();
  datos.registros.forEach(r => {
    hoja.appendRow([
      ahora, datos.periodoEtiqueta, datos.periodoInicio, datos.periodoFin,
      r.codigo, r.nombre, r.cargo || "",
      r.sueldoBasico || 0, r.auxTransporte || 0, r.valHED || 0, r.valHEN || 0, r.valHRN || 0,
      r.valHRDF || 0, r.valHRNDF || 0, r.valHEDF || 0, r.valHENF || 0,
      r.totalDevengado || 0, r.salud || 0, r.pension || 0, r.totalDeducido || 0, r.neto || 0
    ]);
  });

  return respuestaJson({ ok: true, guardados: datos.registros.length });
}

function verificarPeriodoYaCerrado(hoja, periodoEtiqueta) {
  const filas = hoja.getDataRange().getValues();
  for (let i = 1; i < filas.length; i++) {
    if (filas[i][1] === periodoEtiqueta) return true;
  }
  return false;
}

// Devuelve el historial agrupado por período, más reciente primero.
function obtenerHistorialNomina() {
  const hoja = obtenerHojaOpcional(NOMBRE_HOJA_HISTORIAL);
  if (!hoja) return { periodos: [] };

  const filas = hoja.getDataRange().getValues();
  const zona = Session.getScriptTimeZone();
  const porPeriodo = {};

  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    const periodo = fila[1];
    if (!periodo) continue;
    if (!porPeriodo[periodo]) {
      porPeriodo[periodo] = {
        periodo: periodo, periodoInicio: fila[2], periodoFin: fila[3],
        fechaCierre: Utilities.formatDate(new Date(fila[0]), zona, "yyyy-MM-dd HH:mm"),
        registros: []
      };
    }
    porPeriodo[periodo].registros.push({
      codigo: fila[4], nombre: fila[5], cargo: fila[6],
      sueldoBasico: fila[7], auxTransporte: fila[8], neto: fila[19], totalDevengado: fila[16]
    });
  }

  const periodos = Object.values(porPeriodo).sort((a, b) => a.periodo < b.periodo ? 1 : -1);
  return { periodos: periodos };
}


function manejarAjustarHora(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  const tiposValidos = ["ENTRADA", "SALIDA_ALMUERZO", "REGRESO_ALMUERZO", "SALIDA"];
  if (tiposValidos.indexOf(datos.tipoEvento) === -1) {
    return respuestaJson({ ok: false, error: "Tipo de evento inválido" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha)) {
    return respuestaJson({ ok: false, error: "Fecha inválida, debe ser AAAA-MM-DD" });
  }
  if (!/^\d{2}:\d{2}$/.test(datos.nuevaHora)) {
    return respuestaJson({ ok: false, error: "Hora inválida, debe ser HH:mm" });
  }

  const empleado = buscarEmpleadoPorCodigo(datos.codigo);
  if (!empleado) {
    return respuestaJson({ ok: false, error: "Código no encontrado" });
  }

  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const ahora = new Date();
  const zona = Session.getScriptTimeZone();
  const motivo = datos.motivo ? (" — Motivo: " + datos.motivo) : "";
  const observacion = "AJUSTE_MANUAL: corregido desde el panel el " +
    Utilities.formatDate(ahora, zona, "yyyy-MM-dd HH:mm") + motivo;

  hoja.appendRow([
    ahora,                              // A: Marca_Temporal real de cuándo se hizo el ajuste
    datos.fecha,                        // B: Fecha que se está corrigiendo
    datos.nuevaHora + ":00",            // C: Hora corregida
    datos.codigo,                       // D: Codigo
    empleado.nombre,                    // E: Nombre_En_Ese_Momento
    datos.tipoEvento,                   // F: Tipo_Evento
    "", "", "",                         // G,H,I: sin GPS en ajustes manuales
    observacion,                        // J: Observaciones
    ""                                  // K: Foto
  ]);

  return respuestaJson({ ok: true });
}

// ---------------------------------------------------------
// Actualizar un turno específico (día + empleado) en Horario_Semanal
// ---------------------------------------------------------
function manejarActualizarHorario(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  const valoresValidos = ["APERTURA", "MEDIO", "CIERRE", "LIBRE"];
  const nuevoTurno = String(datos.nuevoTurno).toUpperCase().trim();
  if (valoresValidos.indexOf(nuevoTurno) === -1) {
    return respuestaJson({ ok: false, error: "Turno inválido, debe ser APERTURA, CIERRE o LIBRE" });
  }

  const hoja = obtenerHoja(NOMBRE_HOJA_HORARIO);
  const filas = hoja.getDataRange().getValues();
  const encabezados = filas[0];
  const colDia = encabezados.indexOf(datos.dia);
  if (colDia === -1) {
    return respuestaJson({ ok: false, error: "Día no reconocido: " + datos.dia });
  }

  for (let i = 1; i < filas.length; i++) {
    if (filas[i][0] === datos.codigo) {
      hoja.getRange(i + 1, colDia + 1).setValue(nuevoTurno);
      return respuestaJson({ ok: true });
    }
  }
  return respuestaJson({ ok: false, error: "Código no encontrado en Horario_Semanal" });
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
  const zona = Session.getScriptTimeZone();
  const fechaTexto = Utilities.formatDate(ahora, zona, "yyyy-MM-dd");
  const excepcion = obtenerExcepcionHorario(codigo, fechaTexto);
  const turnoProgramado = obtenerTurnoProgramado(codigo, diaSemana);
  const minutosDelDia = ahora.getHours() * 60 + ahora.getMinutes();

  if (tipoEvento === "ENTRADA") {
    if (excepcion) {
      // Hay un horario especial asignado para hoy: manda sobre el turno recurrente.
      const [hE, mE] = excepcion.horaEntrada.split(":").map(Number);
      const diferencia = minutosDelDia - (hE * 60 + mE);
      if (diferencia > TOLERANCIA_TARDE_MIN) {
        observaciones.push("TARDE: " + diferencia + " min después del horario especial asignado (" + excepcion.horaEntrada + ")");
        mensajeParaKiosko = "Llegaste " + diferencia + " minutos tarde respecto a tu horario especial de hoy.";
      }
    } else if (!turnoProgramado || turnoProgramado === "LIBRE") {
      observaciones.push("FUERA_DE_HORARIO: no tenía turno programado el " + diaSemana);
      mensajeParaKiosko = "Atención: hoy no tenías turno programado. Se avisará al encargado.";
    } else {
      const horaInicioEsperada = horaInicioTurno(turnoProgramado);
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

// Busca si hay un horario especial (excepción) asignado para ese código+fecha exacta.
// Si hay varias filas para el mismo día (poco común), se queda con la última.
function obtenerExcepcionHorario(codigo, fechaTexto) {
  const hoja = obtenerHojaOpcional(NOMBRE_HOJA_EXCEPCIONES);
  if (!hoja) return null;
  const filas = hoja.getDataRange().getValues();
  let encontrada = null;
  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    if (fila[0] === codigo && normalizarFecha(fila[1]) === fechaTexto) {
      encontrada = {
        horaEntrada: String(fila[2]).trim(),
        horaSalida: String(fila[3]).trim(),
        motivo: fila[4] || ""
      };
    }
  }
  return encontrada;
}

// Igual que obtenerHoja, pero no truena si la pestaña todavía no existe
// (para no romper el sistema mientras la creas por primera vez).
function obtenerHojaOpcional(nombre) {
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  return libro.getSheetByName(nombre);
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
    if (normalizarFecha(filas[i][1]) === hoy && filas[i][3] === codigo) {
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

// Google Sheets a veces convierte automáticamente el texto "yyyy-MM-dd"
// que escribimos en la columna Fecha a un objeto Date real. Esta función
// normaliza cualquiera de los dos casos a un texto "yyyy-MM-dd" consistente,
// para que las comparaciones de fecha nunca fallen silenciosamente.
function normalizarFecha(valor) {
  if (!valor) return "";
  if (valor instanceof Date) {
    return Utilities.formatDate(valor, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(valor).trim();
}

function respuestaJson(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// ===========================================================
// PANEL DE SOCIOS — resumen diario / semanal / mensual
// ===========================================================
// Carga todas las excepciones de horario del mes: excepciones[fecha][codigo] = {...}
function obtenerExcepcionesDelMes(mesTexto) {
  const hoja = obtenerHojaOpcional(NOMBRE_HOJA_EXCEPCIONES);
  const resultado = {};
  if (!hoja) return resultado;
  const filas = hoja.getDataRange().getValues();
  for (let i = 1; i < filas.length; i++) {
    const codigo = filas[i][0];
    const fecha = normalizarFecha(filas[i][1]);
    if (!fecha || !fecha.startsWith(mesTexto)) continue;
    if (!resultado[fecha]) resultado[fecha] = {};
    resultado[fecha][codigo] = {
      horaEntrada: String(filas[i][2]).trim(),
      horaSalida: String(filas[i][3]).trim(),
      motivo: filas[i][4] || ""
    };
  }
  return resultado;
}

// ---------------------------------------------------------
// Bitácora de un día específico: cada marca (hora exacta) de
// cada colaborador, con las observaciones/alertas que se
// generaron en el momento (tardanza, fuera de horario, horario
// pico, ajustes manuales), comparado contra lo que le tocaba
// ese día según su horario (turno normal o turno especial).
// ---------------------------------------------------------
function calcularBitacoraDia(fecha) {
  const empleados = obtenerEmpleadosActivosConCargo();
  const horarioSemanal = obtenerHorarioSemanalCompleto();
  const diaNombre = DIAS_SEMANA_LUN_A_DOM[diaDeSemanaLunesA0(fecha)];

  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const filas = hoja.getDataRange().getValues();
  const zona = Session.getScriptTimeZone();

  const porEmpleado = {};
  for (let i = 1; i < filas.length; i++) {
    const filaFecha = normalizarFecha(filas[i][1]);
    if (filaFecha !== fecha) continue;
    const codigo = filas[i][3];
    const tipo = filas[i][5];
    const horaCelda = filas[i][2];
    const hora = (horaCelda instanceof Date) ? Utilities.formatDate(horaCelda, zona, "HH:mm:ss") : String(horaCelda).trim();
    const observaciones = String(filas[i][9] || "");
    const esAjuste = observaciones.indexOf("AJUSTE_MANUAL") !== -1;

    if (!porEmpleado[codigo]) porEmpleado[codigo] = [];
    porEmpleado[codigo].push({ tipo: tipo, hora: hora, observaciones: observaciones, ajuste: esAjuste });
  }
  Object.keys(porEmpleado).forEach(cod => porEmpleado[cod].sort((a, b) => a.hora < b.hora ? -1 : (a.hora > b.hora ? 1 : 0)));

  const resultado = empleados.map(emp => {
    const turnoNormal = (horarioSemanal[emp.codigo] || {})[diaNombre] || "LIBRE";
    const excepcion = obtenerExcepcionHorario(emp.codigo, fecha);
    return {
      codigo: emp.codigo, nombre: emp.nombre, cargo: emp.cargo,
      turnoProgramado: turnoNormal,
      excepcion: excepcion,
      eventos: porEmpleado[emp.codigo] || []
    };
  });

  return { fecha: fecha, diaNombre: diaNombre, empleados: resultado };
}

function calcularResumenAdmin(mesTexto) {
  const empleados = obtenerEmpleadosActivosConCargo();
  const horarioSemanal = obtenerHorarioSemanalCompleto();
  const eventos = construirEventosPorDia(mesTexto);
  const excepciones = obtenerExcepcionesDelMes(mesTexto); // excepciones[fecha][codigo] = {horaEntrada,horaSalida,motivo}

  // diario[fecha][codigo] = {horas, incompleto, turno, ajustado, horasExtra}
  const diario = {};
  const mensual = {};
  const mensualExtra = {};  // mensualExtra[codigo] = suma de horas extra del mes (informativo)
  const semanal = {};       // semanal[semanaKey][codigo] = horas
  const semanalTope = {};   // semanalTope[semanaKey] = tope legal vigente esa semana
  const alertas42 = [];         // informativas: superó la jornada ordinaria (genera horas extra)
  const alertasLegales = [];    // graves: violan el máximo legal de horas extra (Art. 22 CST)

  Object.keys(eventos).forEach(codigo => {
    Object.keys(eventos[codigo]).forEach(fecha => {
      const ev = eventos[codigo][fecha];

      let horas = null;
      let incompleto = true;
      if (ev.ENTRADA !== undefined && ev.SALIDA !== undefined) {
        let minutosTrabajados = ev.SALIDA - ev.ENTRADA;
        if (ev.SALIDA_ALMUERZO !== undefined && ev.REGRESO_ALMUERZO !== undefined) {
          minutosTrabajados -= (ev.REGRESO_ALMUERZO - ev.SALIDA_ALMUERZO);
        }
        horas = Math.round((minutosTrabajados / 60) * 100) / 100;
        incompleto = false;
      }

      const diaNombre = DIAS_SEMANA_LUN_A_DOM[diaDeSemanaLunesA0(fecha)];
      const turno = (horarioSemanal[codigo] || {})[diaNombre] || "LIBRE";
      const ajustado = ev._ajustado === true;
      const horasExtraDia = horas !== null ? Math.max(0, Math.round((horas - HORAS_PAGAS_POR_TURNO) * 100) / 100) : 0;
      const excepcionDia = (excepciones[fecha] && excepciones[fecha][codigo]) || null;

      if (!diario[fecha]) diario[fecha] = {};
      diario[fecha][codigo] = { horas: horas, incompleto: incompleto, turno: turno, ajustado: ajustado, horasExtra: horasExtraDia, excepcion: excepcionDia };

      if (horas !== null) {
        mensual[codigo] = Math.round(((mensual[codigo] || 0) + horas) * 100) / 100;
        mensualExtra[codigo] = Math.round(((mensualExtra[codigo] || 0) + horasExtraDia) * 100) / 100;

        if (horasExtraDia > LIMITE_EXTRA_DIARIA_HORAS) {
          const emp = empleados.find(e => e.codigo === codigo);
          alertasLegales.push({
            tipo: "DIARIA", codigo: codigo, nombre: emp ? emp.nombre : codigo,
            fecha: fecha, horasExtra: horasExtraDia, limite: LIMITE_EXTRA_DIARIA_HORAS
          });
        }

        const semanaKey = lunesDeSemana(fecha);
        if (!semanal[semanaKey]) semanal[semanaKey] = {};
        if (!semanalTope[semanaKey]) semanalTope[semanaKey] = topeHorasVigente(semanaKey);
        semanal[semanaKey][codigo] = Math.round(((semanal[semanaKey][codigo] || 0) + horas) * 100) / 100;
      }
    });
  });

  // Arma la lista de alertas de 42h (o el tope vigente que aplique) por semana
  Object.keys(semanal).forEach(semanaKey => {
    const tope = semanalTope[semanaKey];
    Object.keys(semanal[semanaKey]).forEach(codigo => {
      const horas = semanal[semanaKey][codigo];
      if (horas > tope) {
        const emp = empleados.find(e => e.codigo === codigo);
        const horasExtraSemana = Math.round((horas - tope) * 100) / 100;
        alertas42.push({
          codigo: codigo, nombre: emp ? emp.nombre : codigo,
          semanaKey: semanaKey, horas: horas, tope: tope, horasExtra: horasExtraSemana
        });
        if (horasExtraSemana > LIMITE_EXTRA_SEMANAL_HORAS) {
          alertasLegales.push({
            tipo: "SEMANAL", codigo: codigo, nombre: emp ? emp.nombre : codigo,
            semanaKey: semanaKey, horasExtra: horasExtraSemana, limite: LIMITE_EXTRA_SEMANAL_HORAS
          });
        }
      }
    });
  });

  // Asegura que una excepción programada para una fecha futura (todavía sin
  // marcación real) también aparezca en "diario", para que se vea el horario
  // especial planeado aunque la persona aún no haya llegado ese día.
  Object.keys(excepciones).forEach(fecha => {
    Object.keys(excepciones[fecha]).forEach(codigo => {
      if (!diario[fecha]) diario[fecha] = {};
      if (!diario[fecha][codigo]) {
        const diaNombre = DIAS_SEMANA_LUN_A_DOM[diaDeSemanaLunesA0(fecha)];
        const turno = (horarioSemanal[codigo] || {})[diaNombre] || "LIBRE";
        diario[fecha][codigo] = {
          horas: null, incompleto: true, turno: turno, ajustado: false,
          horasExtra: 0, excepcion: excepciones[fecha][codigo]
        };
      }
    });
  });

  return {
    empleados: empleados,
    horarioSemanal: horarioSemanal,
    diario: diario,
    semanal: semanal,
    semanalTope: semanalTope,
    mensual: mensual,
    mensualExtra: mensualExtra,
    alertas42: alertas42,
    alertasLegales: alertasLegales,
    limiteExtraDiaria: LIMITE_EXTRA_DIARIA_HORAS,
    limiteExtraSemanal: LIMITE_EXTRA_SEMANAL_HORAS,
    topeHorasSemanales: TOPE_HORAS_SEMANALES,
    horasPagasPorTurno: HORAS_PAGAS_POR_TURNO
  };
}

// ---------------------------------------------------------
// Construye, para un mes, los eventos consolidados por
// empleado y día: { ENTRADA, SALIDA_ALMUERZO, REGRESO_ALMUERZO, SALIDA }
// en minutos. Los ajustes manuales (Observaciones con "AJUSTE_MANUAL")
// siempre tienen prioridad sobre la marca original, sin importar
// el orden en que aparezcan en la hoja — así una corrección hecha
// hoy sí reemplaza una marca (o una ausencia de marca) de hace días,
// sin borrar nunca el registro original.
// ---------------------------------------------------------
function construirEventosPorDia(mesTexto, fechaInicio, fechaFin) {
  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const filas = hoja.getDataRange().getValues();

  const eventos = {};
  const vieneDeAjuste = {};

  for (let i = 1; i < filas.length; i++) {
    const fecha = normalizarFecha(filas[i][1]);
    if (fechaInicio && fechaFin) {
      if (!fecha || fecha < fechaInicio || fecha > fechaFin) continue;
    } else {
      if (!fecha || !fecha.startsWith(mesTexto)) continue;
    }
    const codigo = filas[i][3];
    const tipo = filas[i][5];
    const minutos = horaStrAMinutos(filas[i][2]);
    const observaciones = String(filas[i][9] || "");
    const esAjuste = observaciones.indexOf("AJUSTE_MANUAL") !== -1;

    if (!eventos[codigo]) eventos[codigo] = {};
    if (!eventos[codigo][fecha]) eventos[codigo][fecha] = {};
    if (!vieneDeAjuste[codigo]) vieneDeAjuste[codigo] = {};
    if (!vieneDeAjuste[codigo][fecha]) vieneDeAjuste[codigo][fecha] = {};

    const yaEsAjuste = vieneDeAjuste[codigo][fecha][tipo] === true;
    if (yaEsAjuste && !esAjuste) continue; // un ajuste vigente no se deja pisar por una marca normal

    if (esAjuste) {
      eventos[codigo][fecha][tipo] = minutos;
      vieneDeAjuste[codigo][fecha][tipo] = true;
      eventos[codigo][fecha]._ajustado = true;
    } else if (tipo === "ENTRADA") {
      if (eventos[codigo][fecha].ENTRADA === undefined) eventos[codigo][fecha].ENTRADA = minutos;
    } else {
      eventos[codigo][fecha][tipo] = minutos;
    }
  }
  return eventos;
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

function calcularResumenNomina(mesTexto, fechaInicio, fechaFin, divisorHorasPeriodo) {
  const empleados = obtenerEmpleadosActivosConSalario();
  const eventos = construirEventosPorDia(mesTexto, fechaInicio, fechaFin);
  const divisor = divisorHorasPeriodo || DIVISOR_HORAS_MES;
  const fraccionPeriodo = divisor / DIVISOR_HORAS_MES; // 1 = mes completo, 0.5 = quincena

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
      valorHora = emp.salarioMensual / DIVISOR_HORAS_MES; // el valor/hora nunca cambia, sea mes o quincena
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
      auxilioTransporte: Math.round((emp.auxilioTransporte || 0) * fraccionPeriodo),
      cedula: emp.cedula, direccion: emp.direccion, email: emp.email, telefono: emp.telefono,
      eps: emp.eps, afp: emp.afp, arl: emp.arl, banco: emp.banco, cuenta: emp.cuenta
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
      divisorHorasMes: divisor
    },
    aviso: "Cálculo de referencia. Valida las tasas y festivos con tu contador antes de usar para nómina real."
  };
}

function obtenerEmpleadosActivosConSalario() {
  const hoja = obtenerHoja(NOMBRE_HOJA_EMPLEADOS);
  const filas = hoja.getDataRange().getValues();
  const encabezados = filas[0];
  const col = (nombreCol) => encabezados.indexOf(nombreCol);
  const colSalario = col("Salario_Mensual");
  const colIngreso = col("Fecha_Ingreso");
  const colCedula = col("Cedula");
  const colDireccion = col("Direccion");
  const colEmail = col("Email");
  const colTelefono = col("Telefono");
  const colEPS = col("EPS");
  const colAFP = col("AFP");
  const colARL = col("ARL");
  const colBanco = col("Banco");
  const colCuenta = col("Cuenta_Bancaria");

  const leer = (fila, colIdx) => (colIdx > -1 && fila[colIdx]) ? fila[colIdx] : "";

  const resultado = [];
  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    const [codigo, nombre, pin, activo, cargo] = fila;
    if (codigo && activo === true) {
      const salarioMensual = colSalario > -1 ? Number(fila[colSalario]) || 0 : 0;
      resultado.push({
        codigo: codigo, nombre: nombre, cargo: cargo,
        salarioMensual: salarioMensual,
        fechaIngreso: colIngreso > -1 ? fila[colIngreso] : null,
        auxilioTransporte: (salarioMensual > 0 && salarioMensual <= TOPE_SALARIOS_AUXILIO_TRANSPORTE) ? AUXILIO_TRANSPORTE_2026 : 0,
        cedula: leer(fila, colCedula),
        direccion: leer(fila, colDireccion),
        email: leer(fila, colEmail),
        telefono: leer(fila, colTelefono),
        eps: leer(fila, colEPS),
        afp: leer(fila, colAFP),
        arl: leer(fila, colARL),
        banco: leer(fila, colBanco),
        cuenta: leer(fila, colCuenta)
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
