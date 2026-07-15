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
const NOMBRE_HOJA_NOVEDADES = "Novedades";

// Zona horaria fija de Montana — NO usar Session.getScriptTimeZone() porque
// depende de una configuración del proyecto/hoja que puede no coincidir con
// Colombia y desfasar todas las horas registradas.
const ZONA_HORARIA_MONTANA = "America/Bogota";

// Valores por defecto de cada turno — se pueden cambiar desde la pestaña
// "Configuración" del panel sin tocar el código (quedan guardados en
// PropertiesService). "horas" es cuánto se le paga (7 para jornada de 42h,
// 6 para jornada de 36h/6x6).
const TURNOS_POR_DEFECTO = {
  APERTURA:  { horaInicio: 9,  horas: 7, jornada: "42" },
  MEDIO:     { horaInicio: 10, horas: 7, jornada: "42" },
  CIERRE:    { horaInicio: 11, horas: 7, jornada: "42" },
  APERTURA36:{ horaInicio: 9,  horas: 6, jornada: "36" },
  MEDIO36:   { horaInicio: 11, horas: 6, jornada: "36" },
  CIERRE36:  { horaInicio: 13, horas: 6, jornada: "36" }
};
const TOLERANCIA_TARDE_MIN = 10;

// Límites legales de horas extra (Art. 22 CST) — esto SÍ es una violación,
// distinto de simplemente superar la jornada ordinaria (lo cual solo implica
// que hay que pagar recargo/extra, no que sea ilegal).
const LIMITE_EXTRA_DIARIA_HORAS = 2;
const LIMITE_EXTRA_SEMANAL_HORAS = 12;

// Lee la configuración de turnos guardada (o los valores por defecto si
// todavía no se ha guardado nada). Se cachea en memoria durante la misma
// ejecución para no leer PropertiesService varias veces.
let _configTurnosCache = null;
function obtenerConfiguracionTurnos() {
  if (_configTurnosCache) return _configTurnosCache;
  const guardado = PropertiesService.getScriptProperties().getProperty("config_turnos");
  _configTurnosCache = guardado ? JSON.parse(guardado) : JSON.parse(JSON.stringify(TURNOS_POR_DEFECTO));
  return _configTurnosCache;
}
function guardarConfiguracionTurnos(config) {
  PropertiesService.getScriptProperties().setProperty("config_turnos", JSON.stringify(config));
  _configTurnosCache = config;
}

function horaInicioTurno(turno) {
  const config = obtenerConfiguracionTurnos();
  return config[turno] ? config[turno].horaInicio : null;
}
function horasPorTurno(turno) {
  const config = obtenerConfiguracionTurnos();
  return config[turno] ? config[turno].horas : HORAS_PAGAS_POR_TURNO; // LIBRE u otro valor raro -> por defecto
}
function jornadaDeTurno(turno) {
  const config = obtenerConfiguracionTurnos();
  return config[turno] ? config[turno].jornada : "42";
}
function esTurnoValido(turno) {
  const config = obtenerConfiguracionTurnos();
  return !!config[turno];
}

// Un empleado "es" de jornada 6x6 si en su horario semanal tiene asignado
// cualquier turno de la familia 36h (APERTURA36/MEDIO36/CIERRE36).
function empleadoTieneJornada36(codigo, horarioSemanal) {
  const horarioEmp = horarioSemanal[codigo];
  if (!horarioEmp) return false;
  return Object.values(horarioEmp).some(turno => esTurnoValido(turno) && jornadaDeTurno(turno) === "36");
}

const HORAS_PAGAS_POR_TURNO = 7; // referencia para jornada de 42h — para 36h usar horasPorTurno(turno)

// ⚠️ Acuerdo con el equipo: aunque el almuerzo real marcado sea más corto
// (ej. 30 min), siempre se descuenta como mínimo esta cantidad de las horas
// trabajadas del día. Así esos minutos "cedidos" durante el almuerzo nunca
// se cuentan como tiempo pagado ni generan hora extra. Si el almuerzo real
// marcado es MÁS largo que esto, se respeta el real (nunca se descuenta menos).
const MINUTOS_MINIMOS_ALMUERZO = 60;

// ⚠️ La jornada máxima semanal en Colombia baja por fases (Ley 2101 de 2021).
// Este valor representa el tope vigente HOY; para meses históricos, el
// cálculo real por semana usa topeHorasVigente(fecha) más abajo.
const TOPE_HORAS_SEMANALES = topeHorasVigente(Utilities.formatDate(new Date(), ZONA_HORARIA_MONTANA, "yyyy-MM-dd"));

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
    const ultimoDiaReal = new Date(Number(mes.slice(0,4)), Number(mes.slice(5,7)), 0).getDate();
    const ultimoDia = Math.min(ultimoDiaReal, 30); // mes comercial de 30 días
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

  if (accion === "calcularCesantias") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) return respuestaJson({ error: "PIN inválido" });
    return respuestaJson(calcularCesantias(e.parameter.codigo, Number(e.parameter.anio)));
  }

  if (accion === "calcularPrima") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) return respuestaJson({ error: "PIN inválido" });
    return respuestaJson(calcularPrima(e.parameter.codigo, Number(e.parameter.anio), Number(e.parameter.semestre)));
  }

  if (accion === "calcularVacaciones") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) return respuestaJson({ error: "PIN inválido" });
    return respuestaJson(calcularVacaciones(e.parameter.codigo, e.parameter.fechaInicio, e.parameter.fechaFin));
  }

  if (accion === "calcularLiquidacionFinal") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) return respuestaJson({ error: "PIN inválido" });
    return respuestaJson(calcularLiquidacionFinal(e.parameter.codigo, e.parameter.fechaRetiro));
  }

  if (accion === "resumenProvisiones") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) {
      return respuestaJson({ error: "PIN inválido" });
    }
    const mes = e.parameter.mes;
    return respuestaJson(calcularProvisiones(mes));
  }

  if (accion === "obtenerConfiguracionTurnos") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) return respuestaJson({ error: "PIN inválido" });
    return respuestaJson({ turnos: obtenerConfiguracionTurnos() });
  }

  if (accion === "novedadesAnio") {
    if (String(e.parameter.pin) !== PIN_PANEL_SOCIOS) return respuestaJson({ error: "PIN inválido" });
    const anio = e.parameter.anio;
    const novedadesRango = obtenerNovedadesRango(anio + "-01-01", anio + "-12-31");
    const empleados = obtenerEmpleadosActivos();
    const lista = [];
    Object.keys(novedadesRango).forEach(codigo => {
      const emp = empleados.find(x => x.codigo === codigo);
      Object.keys(novedadesRango[codigo]).forEach(fecha => {
        const n = novedadesRango[codigo][fecha];
        lista.push({ codigo: codigo, nombre: emp ? emp.nombre : codigo, fecha: fecha, tipo: n.tipo, motivo: n.motivo, estado: n.estado, autorizadoPor: n.autorizadoPor });
      });
    });
    lista.sort((a, b) => a.fecha < b.fecha ? -1 : 1);
    return respuestaJson({ novedades: lista });
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
  if (datos.accion === "actualizarFotoRegistro") return manejarActualizarFotoRegistro(datos);
  if (datos.accion === "renombrarEmpleado") return manejarRenombrar(datos);
  if (datos.accion === "actualizarHorario") return manejarActualizarHorario(datos);
  if (datos.accion === "ajustarHora") return manejarAjustarHora(datos);
  if (datos.accion === "guardarExcepcion") return manejarGuardarExcepcion(datos);
  if (datos.accion === "cerrarPeriodoNomina") return manejarCerrarPeriodoNomina(datos);
  if (datos.accion === "guardarNovedad") return manejarGuardarNovedad(datos);
  if (datos.accion === "actualizarEstadoNovedad") return manejarActualizarEstadoNovedad(datos);
  if (datos.accion === "guardarConfiguracionTurnos") return manejarGuardarConfiguracionTurnos(datos);
  if (datos.accion === "actualizarCategoriaEmpleado") return manejarActualizarCategoriaEmpleado(datos);
  if (datos.accion === "cerrarTurnosAbandonadosManual") {
    if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) return respuestaJson({ ok: false, error: "PIN de socios inválido" });
    const cerrados = cerrarTurnosAbandonados();
    return respuestaJson({ ok: true, cerrados: cerrados });
  }

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
  const ahoraServidor = new Date();
  const zona = ZONA_HORARIA_MONTANA;

  // Si el kiosko no tenía internet en el momento de marcar, el registro se
  // guardó localmente en el celular y se sube después con "marcaClienteISO"
  // — la hora que se guarda es la real (cuándo la persona marcó), no la
  // hora en que por fin hubo señal. Queda constancia clara de esto en
  // Observaciones, para que sea transparente y revisable.
  let ahora = ahoraServidor;
  let notaSincronizacionOffline = "";
  if (datos.marcaClienteISO) {
    const fechaCliente = new Date(datos.marcaClienteISO);
    if (!isNaN(fechaCliente.getTime())) {
      ahora = fechaCliente;
      const diferenciaMin = Math.round((ahoraServidor - fechaCliente) / 60000);
      if (diferenciaMin > 2) {
        notaSincronizacionOffline = "SINCRONIZADO_OFFLINE: marcado sin conexión, subido " + diferenciaMin + " min después (" + Utilities.formatDate(ahoraServidor, zona, "yyyy-MM-dd HH:mm") + ")";
      }
    }
  }

  // Si el cálculo de alertas falla por cualquier motivo (turno mal configurado,
  // hoja de excepciones con datos raros, etc.), el registro se debe guardar
  // igual — la marcación en sí es lo prioritario, la alerta es solo informativa.
  let alertas = { observaciones: "", mensajeParaKiosko: "" };
  try {
    alertas = calcularAlertas(datos.codigo, datos.tipoEvento, ahora);
  } catch (errorAlertas) {
    alertas = { observaciones: "ERROR_AL_CALCULAR_ALERTA: " + errorAlertas.message, mensajeParaKiosko: "" };
  }
  if (notaSincronizacionOffline) {
    alertas.observaciones = (alertas.observaciones ? alertas.observaciones + " | " : "") + notaSincronizacionOffline;
  }

  // La foto se sube DESPUÉS, en una llamada aparte (ver manejarActualizarFotoRegistro
  // más abajo) — no aquí. Subir a Drive puede tardar varios segundos, y si el
  // registro completo depende de esperar eso, cualquier demora en Drive o en
  // la conexión hace que el kiosko muestre error aunque el dato ya se hubiera
  // guardado. Así, lo esencial (marcar la hora) siempre es rápido y confiable.
  const fechaTexto = Utilities.formatDate(ahora, zona, "yyyy-MM-dd");
  const horaTexto = Utilities.formatDate(ahora, zona, "HH:mm:ss");

  hoja.appendRow([
    ahora,
    "'" + fechaTexto,  // el apóstrofe fuerza texto plano desde el momento de escribir
    "'" + horaTexto,
    datos.codigo,
    empleado.nombre,              // nombre "congelado" en el momento del registro
    datos.tipoEvento,
    datos.lat || "",
    datos.lng || "",
    datos.precision || "",
    alertas.observaciones,
    ""                             // Foto: se completa después, ver manejarActualizarFotoRegistro
  ]);

  return respuestaJson({ ok: true, alerta: alertas.mensajeParaKiosko, fila: hoja.getLastRow() });
}

// ---------------------------------------------------------
// Sube la foto a Drive y la asocia a una fila ya guardada.
// Se llama DESPUÉS de manejarRegistrar, como una petición aparte que el
// kiosko no espera — así la foto nunca puede hacer fallar el registro.
// ---------------------------------------------------------
function manejarActualizarFotoRegistro(datos) {
  const empleado = buscarEmpleadoPorCodigo(datos.codigo);
  if (!empleado || String(empleado.pin) !== String(datos.pin)) {
    return respuestaJson({ ok: false, error: "PIN inválido" });
  }
  if (!datos.fila) {
    return respuestaJson({ ok: false, error: "Falta el número de fila" });
  }

  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const fila = Number(datos.fila);

  // Verifica que esa fila sí sea del empleado correcto, por seguridad básica.
  const codigoEnFila = hoja.getRange(fila, 4).getValue();
  if (String(codigoEnFila) !== String(datos.codigo)) {
    return respuestaJson({ ok: false, error: "La fila no corresponde a este empleado" });
  }

  const urlFoto = guardarFoto(datos.foto, empleado.nombre, new Date());
  hoja.getRange(fila, 11).setValue(urlFoto); // columna K: Foto

  return respuestaJson({ ok: true });
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

  hoja.appendRow([datos.codigo, "'" + datos.fecha, "'" + datos.horaEntrada, "'" + datos.horaSalida, datos.motivo || ""]);

  return respuestaJson({ ok: true });
}

// ---------------------------------------------------------
// Novedades: incapacidades, permisos u otras ausencias
// justificadas. Un día con novedad NO se descuenta como
// inasistencia en el cálculo de nómina.
// ---------------------------------------------------------
const TIPOS_NOVEDAD_VALIDOS = ["INCAPACIDAD", "PERMISO", "VACACIONES", "OTRO"];

// Estados de revisión de una novedad — hasta que un socio la revise, queda
// en PENDIENTE y NO se descuenta (beneficio de la duda). Solo pasa a
// descontarse si explícitamente se marca SIN_SOPORTE_DESCONTAR.
const ESTADOS_NOVEDAD_VALIDOS = ["PENDIENTE", "VALIDADA_SOPORTE", "SIN_SOPORTE_DESCONTAR", "SOLICITAR_EPS"];

function manejarGuardarNovedad(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha)) {
    return respuestaJson({ ok: false, error: "Fecha inválida, debe ser AAAA-MM-DD" });
  }
  const tipo = String(datos.tipo || "").toUpperCase().trim();
  if (TIPOS_NOVEDAD_VALIDOS.indexOf(tipo) === -1) {
    return respuestaJson({ ok: false, error: "Tipo de novedad inválido" });
  }
  const motivo = String(datos.motivo || "").trim();
  if (!motivo) {
    return respuestaJson({ ok: false, error: "La observación es obligatoria — explica qué pasó." });
  }
  const autorizadoPor = String(datos.autorizadoPor || "").trim();
  if (!autorizadoPor) {
    return respuestaJson({ ok: false, error: "Debes indicar quién autoriza esta novedad." });
  }
  const empleado = buscarEmpleadoPorCodigo(datos.codigo);
  if (!empleado) {
    return respuestaJson({ ok: false, error: "Código no encontrado" });
  }

  let hoja = obtenerHojaOpcional(NOMBRE_HOJA_NOVEDADES);
  if (!hoja) {
    const libro = SpreadsheetApp.getActiveSpreadsheet();
    hoja = libro.insertSheet(NOMBRE_HOJA_NOVEDADES);
    hoja.appendRow(["Codigo", "Fecha", "Tipo", "Motivo", "Creado_En", "Estado", "Autorizado_Por"]);
  }
  let colAutorizado = hoja.getDataRange().getValues()[0].indexOf("Autorizado_Por");
  if (colAutorizado === -1) {
    colAutorizado = hoja.getLastColumn();
    hoja.getRange(1, colAutorizado + 1).setValue("Autorizado_Por");
  }

  const fila = [datos.codigo, datos.fecha, tipo, motivo, new Date(), "PENDIENTE"];
  fila[colAutorizado] = autorizadoPor;
  hoja.appendRow(fila);
  return respuestaJson({ ok: true });
}

// ---------------------------------------------------------
// Cambia el estado de revisión de una novedad ya registrada.
// - VALIDADA_SOPORTE: hay permiso/soporte válido → no se descuenta.
// - SIN_SOPORTE_DESCONTAR: no hay soporte → sí se descuenta el día.
// - SOLICITAR_EPS: incapacidad con soporte de EPS → no se descuenta al
//   empleado, pero queda marcada para reclamar el pago a la EPS.
// ---------------------------------------------------------
function manejarActualizarEstadoNovedad(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  const estado = String(datos.estado || "").toUpperCase().trim();
  if (ESTADOS_NOVEDAD_VALIDOS.indexOf(estado) === -1) {
    return respuestaJson({ ok: false, error: "Estado no válido" });
  }
  const hoja = obtenerHojaOpcional(NOMBRE_HOJA_NOVEDADES);
  if (!hoja) return respuestaJson({ ok: false, error: "No hay novedades registradas todavía" });

  const filas = hoja.getDataRange().getValues();
  const encabezados = filas[0];
  let colEstado = encabezados.indexOf("Estado");
  if (colEstado === -1) {
    colEstado = encabezados.length;
    hoja.getRange(1, colEstado + 1).setValue("Estado");
  }

  for (let i = 1; i < filas.length; i++) {
    if (filas[i][0] === datos.codigo && normalizarFecha(filas[i][1]) === datos.fecha) {
      hoja.getRange(i + 1, colEstado + 1).setValue(estado);
      return respuestaJson({ ok: true });
    }
  }
  return respuestaJson({ ok: false, error: "No se encontró esa novedad" });
}

// ---------------------------------------------------------
// Configuración de turnos (pestaña Configuración del panel):
// cambia la hora de inicio de cualquiera de los 6 turnos
// (3 de jornada 42h, 3 de jornada 36h/6x6).
// ---------------------------------------------------------
// ---------------------------------------------------------
// Categoría de empleado (pestaña Configuración): una sola opción que
// resume las 3 cosas que hoy viven en lugares separados — Cargo_Confianza,
// Tipo_Personal, y la jornada (42h/36h, que en realidad se guarda como el
// turno asignado día a día en Horario_Semanal). Al elegir 42h o 36h aquí,
// convierte automáticamente todos los turnos ya asignados de esa persona
// a la familia correspondiente (Apertura/Medio/Cierre se preservan, solo
// cambia si es la versión de 42h o la de 36h) — así no hay que ir día por
// día reprogramando en "Turnos y personal".
// ---------------------------------------------------------
const MAPA_TURNO_A_FAMILIA = {
  APERTURA:   { "42": "APERTURA", "36": "APERTURA36" },
  MEDIO:      { "42": "MEDIO",    "36": "MEDIO36" },
  CIERRE:     { "42": "CIERRE",   "36": "CIERRE36" },
  APERTURA36: { "42": "APERTURA", "36": "APERTURA36" },
  MEDIO36:    { "42": "MEDIO",    "36": "MEDIO36" },
  CIERRE36:   { "42": "CIERRE",   "36": "CIERRE36" }
};
const CATEGORIAS_EMPLEADO_VALIDAS = ["PLANTA_42", "PLANTA_36", "TURNO", "CONFIANZA"];

function manejarActualizarCategoriaEmpleado(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  const categoria = String(datos.categoria || "").toUpperCase().trim();
  if (CATEGORIAS_EMPLEADO_VALIDAS.indexOf(categoria) === -1) {
    return respuestaJson({ ok: false, error: "Categoría no válida" });
  }

  const hojaEmp = obtenerHoja(NOMBRE_HOJA_EMPLEADOS);
  const filasEmp = hojaEmp.getDataRange().getValues();
  const encabezadosEmp = filasEmp[0];
  let colConfianza = encabezadosEmp.indexOf("Cargo_Confianza");
  let colTipoPersonal = encabezadosEmp.indexOf("Tipo_Personal");
  if (colConfianza === -1) {
    colConfianza = hojaEmp.getLastColumn();
    hojaEmp.getRange(1, colConfianza + 1).setValue("Cargo_Confianza");
  }
  if (colTipoPersonal === -1) {
    colTipoPersonal = hojaEmp.getLastColumn();
    hojaEmp.getRange(1, colTipoPersonal + 1).setValue("Tipo_Personal");
  }

  let filaEmpleado = -1;
  for (let i = 1; i < filasEmp.length; i++) {
    if (filasEmp[i][0] === datos.codigo) { filaEmpleado = i + 1; break; }
  }
  if (filaEmpleado === -1) return respuestaJson({ ok: false, error: "Código no encontrado" });

  const esConfianza = categoria === "CONFIANZA";
  const esTurno = categoria === "TURNO";
  hojaEmp.getRange(filaEmpleado, colConfianza + 1).setValue(esConfianza);
  hojaEmp.getRange(filaEmpleado, colTipoPersonal + 1).setValue(esTurno ? "TURNO" : "PLANTA");

  if (categoria === "PLANTA_42" || categoria === "PLANTA_36") {
    const jornadaDestino = categoria === "PLANTA_42" ? "42" : "36";
    const hojaHorario = obtenerHoja(NOMBRE_HOJA_HORARIO);
    const filasHorario = hojaHorario.getDataRange().getValues();
    const encabezadosHorario = filasHorario[0];
    for (let i = 1; i < filasHorario.length; i++) {
      if (filasHorario[i][0] !== datos.codigo) continue;
      for (let c = 1; c < encabezadosHorario.length; c++) {
        const turnoActual = String(filasHorario[i][c] || "LIBRE").toUpperCase().trim();
        if (turnoActual === "LIBRE" || !MAPA_TURNO_A_FAMILIA[turnoActual]) continue;
        const nuevoTurno = MAPA_TURNO_A_FAMILIA[turnoActual][jornadaDestino];
        if (nuevoTurno && nuevoTurno !== turnoActual) {
          hojaHorario.getRange(i + 1, c + 1).setValue(nuevoTurno);
        }
      }
      break;
    }
  }

  return respuestaJson({ ok: true });
}

function manejarGuardarConfiguracionTurnos(datos) {
  if (String(datos.pinSocios) !== PIN_PANEL_SOCIOS) {
    return respuestaJson({ ok: false, error: "PIN de socios inválido" });
  }
  if (!datos.turno || typeof datos.horaInicio !== "number") {
    return respuestaJson({ ok: false, error: "Faltan datos (turno, horaInicio)" });
  }
  const config = obtenerConfiguracionTurnos();
  if (!config[datos.turno]) {
    return respuestaJson({ ok: false, error: "Ese turno no existe" });
  }
  if (datos.horaInicio < 0 || datos.horaInicio > 23) {
    return respuestaJson({ ok: false, error: "La hora debe estar entre 0 y 23" });
  }
  config[datos.turno].horaInicio = datos.horaInicio;
  guardarConfiguracionTurnos(config);
  return respuestaJson({ ok: true });
}

// Devuelve, para un rango de fechas, qué días de cada empleado
// tienen una novedad registrada: { codigo: { fecha: tipo } }
function obtenerNovedadesRango(fechaInicio, fechaFin) {
  const hoja = obtenerHojaOpcional(NOMBRE_HOJA_NOVEDADES);
  if (!hoja) return {};
  const filas = hoja.getDataRange().getValues();
  const encabezados = filas[0];
  const colEstado = encabezados.indexOf("Estado");
  const colAutorizado = encabezados.indexOf("Autorizado_Por");
  const resultado = {};
  for (let i = 1; i < filas.length; i++) {
    const codigo = filas[i][0];
    const fecha = normalizarFecha(filas[i][1]);
    if (!fecha || fecha < fechaInicio || fecha > fechaFin) continue;
    if (!resultado[codigo]) resultado[codigo] = {};
    resultado[codigo][fecha] = {
      tipo: filas[i][2],
      motivo: filas[i][3] || "",
      estado: (colEstado > -1 && filas[i][colEstado]) ? filas[i][colEstado] : "PENDIENTE",
      autorizadoPor: (colAutorizado > -1 && filas[i][colAutorizado]) ? filas[i][colAutorizado] : ""
    };
  }
  return resultado;
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
      "Total_Devengado", "Salud", "Pension", "Total_Deducido", "Neto_Pagado", "Tipo_Personal"
    ]);
  }
  // Si la hoja ya existía de antes (sin esta columna), la agrega ahora al final
  // — así los períodos que ya cerraste antes no se pierden ni se dañan, solo
  // quedan sin ese dato (se muestran como "Planta" por defecto al leerlos).
  let colTipoPersonal = hoja.getDataRange().getValues()[0].indexOf("Tipo_Personal");
  if (colTipoPersonal === -1) {
    colTipoPersonal = hoja.getLastColumn();
    hoja.getRange(1, colTipoPersonal + 1).setValue("Tipo_Personal");
  }

  // Evita cerrar el mismo período dos veces para la misma persona sin darse cuenta.
  const yaExiste = verificarPeriodoYaCerrado(hoja, datos.periodoEtiqueta);
  if (yaExiste && !datos.confirmarReemplazo) {
    return respuestaJson({ ok: false, yaExiste: true, error: "Este período ya fue cerrado antes. Confirma si quieres guardar una nueva versión." });
  }

  const ahora = new Date();
  datos.registros.forEach(r => {
    const fila = [
      ahora, datos.periodoEtiqueta, datos.periodoInicio, datos.periodoFin,
      r.codigo, r.nombre, r.cargo || "",
      r.sueldoBasico || 0, r.auxTransporte || 0, r.valHED || 0, r.valHEN || 0, r.valHRN || 0,
      r.valHRDF || 0, r.valHRNDF || 0, r.valHEDF || 0, r.valHENF || 0,
      r.totalDevengado || 0, r.salud || 0, r.pension || 0, r.totalDeducido || 0, r.neto || 0
    ];
    fila[colTipoPersonal] = r.tipo || "PLANTA"; // "PLANTA" | "TURNO" | "6X6"
    hoja.appendRow(fila);
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
  const zona = ZONA_HORARIA_MONTANA;
  const porPeriodo = {};
  const colTipoPersonal = filas[0].indexOf("Tipo_Personal"); // -1 si es un historial de antes de este cambio

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
      sueldoBasico: fila[7], auxTransporte: fila[8], neto: fila[19], totalDevengado: fila[16],
      tipoPersonal: (colTipoPersonal > -1 && fila[colTipoPersonal]) ? fila[colTipoPersonal] : "PLANTA"
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
  const zona = ZONA_HORARIA_MONTANA;
  const motivo = datos.motivo ? (" — Motivo: " + datos.motivo) : "";
  const observacion = "AJUSTE_MANUAL: corregido desde el panel el " +
    Utilities.formatDate(ahora, zona, "yyyy-MM-dd HH:mm") + motivo;

  hoja.appendRow([
    ahora,                              // A: Marca_Temporal real de cuándo se hizo el ajuste
    "'" + datos.fecha,                  // B: Fecha que se está corrigiendo (apóstrofe = texto forzado)
    "'" + datos.nuevaHora + ":00",      // C: Hora corregida (apóstrofe = texto forzado)
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
  const valoresValidos = ["APERTURA", "MEDIO", "CIERRE", "APERTURA36", "MEDIO36", "CIERRE36", "LIBRE"];
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
    const zona = ZONA_HORARIA_MONTANA;
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
  const zona = ZONA_HORARIA_MONTANA;
  const fechaTexto = Utilities.formatDate(ahora, zona, "yyyy-MM-dd");
  const excepcion = obtenerExcepcionHorario(codigo, fechaTexto);
  const turnoProgramado = obtenerTurnoProgramado(codigo, diaSemana);
  const minutosDelDia = horaStrAMinutos(Utilities.formatDate(ahora, zona, "HH:mm"));

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
        horaEntrada: normalizarHora(fila[2]),
        horaSalida: normalizarHora(fila[3]),
        motivo: fila[4] || ""
      };
    }
  }
  return encontrada;
}

// Igual que obtenerExcepcionHorario, pero lee la hoja de Excepciones_Horario
// UNA SOLA VEZ para todo un rango de fechas, en vez de una vez por cada
// día de cada empleado (que es lo que la hacía tan lenta antes).
// Devuelve { codigo: { fecha: {horaEntrada, horaSalida, motivo} } }
function obtenerExcepcionesRango(fechaInicio, fechaFin) {
  const hoja = obtenerHojaOpcional(NOMBRE_HOJA_EXCEPCIONES);
  if (!hoja) return {};
  const filas = hoja.getDataRange().getValues();
  const resultado = {};
  for (let i = 1; i < filas.length; i++) {
    const codigo = filas[i][0];
    const fecha = normalizarFecha(filas[i][1]);
    if (!fecha || fecha < fechaInicio || fecha > fechaFin) continue;
    if (!resultado[codigo]) resultado[codigo] = {};
    resultado[codigo][fecha] = {
      horaEntrada: normalizarHora(filas[i][2]),
      horaSalida: normalizarHora(filas[i][3]),
      motivo: filas[i][4] || ""
    };
  }
  return resultado;
}

// Google Sheets a veces convierte automáticamente un texto "HH:mm" en un
// valor de hora real (un objeto Date con fecha 30-dic-1899, el "cero" de
// Sheets). Si luego se lee con String(), sale algo como
// "Sat Dec 30 1899 07:21:44 GMT-0456 (hora estándar de Colombia)" —
// esta función evita eso, devolviendo siempre un texto limpio "HH:mm".
function normalizarHora(valor) {
  if (!valor) return "";
  if (valor instanceof Date) {
    return Utilities.formatDate(valor, ZONA_HORARIA_MONTANA, "HH:mm");
  }
  return String(valor).trim().replace(/^'/, "").slice(0, 5);
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
  const zona = ZONA_HORARIA_MONTANA;
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

// ---------------------------------------------------------
// Cierra automáticamente los turnos "abandonados": alguien marcó Entrada
// pero nunca marcó Salida (ni almuerzo) ese día, y ya pasó a un día distinto
// al de hoy. Sin esto, el sistema pensaría que la persona sigue trabajando
// para siempre, y el día siguiente arrancaría con datos pegados del anterior.
//
// Solo toca días ANTERIORES a hoy — nunca el día de hoy, para no cerrarle
// el turno a alguien que legítimamente sigue trabajando en este momento.
//
// ⚠️ Esta función necesita un disparador de tiempo para ejecutarse sola.
// Configúralo una sola vez: en el editor de Apps Script, ícono del reloj
// (⏱️ Activadores) → Añadir activador → función "cerrarTurnosAbandonados"
// → Basado en tiempo → Temporizador diario → elige un horario como 2–3 a.m.
// ---------------------------------------------------------
function cerrarTurnosAbandonados() {
  const zona = ZONA_HORARIA_MONTANA;
  const hoy = Utilities.formatDate(new Date(), zona, "yyyy-MM-dd");

  // Solo revisa los últimos 10 días hacia atrás — de sobra para este caso,
  // y evita releer todo el histórico completo cada vez que corre.
  const hace10Dias = new Date();
  hace10Dias.setDate(hace10Dias.getDate() - 10);
  const fechaInicio = Utilities.formatDate(hace10Dias, zona, "yyyy-MM-dd");

  const eventos = construirEventosPorDia(null, fechaInicio, hoy);
  const empleados = obtenerEmpleadosActivos();
  const horarioSemanal = obtenerHorarioSemanalCompleto();
  const excepcionesRango = obtenerExcepcionesRango(fechaInicio, hoy);
  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);

  let cerrados = 0;

  Object.keys(eventos).forEach(codigo => {
    Object.keys(eventos[codigo]).forEach(fecha => {
      if (fecha >= hoy) return; // nunca tocar hoy ni el futuro
      const ev = eventos[codigo][fecha];
      if (ev.ENTRADA === undefined || ev.SALIDA !== undefined) return; // ya está completo, o ni siquiera entró

      // Calcula a qué hora debía terminar ese turno, para usarla como hora
      // de cierre automático (así el reporte de horas queda razonable, no
      // en 0 ni contando de más).
      const diaNombre = DIAS_SEMANA_LUN_A_DOM[diaDeSemanaLunesA0(fecha)];
      const excepcion = excepcionesRango[codigo] && excepcionesRango[codigo][fecha];
      const turno = excepcion ? null : ((horarioSemanal[codigo] || {})[diaNombre] || "LIBRE");

      let horaFinMin;
      if (excepcion && excepcion.horaSalida) {
        const [hs, ms] = excepcion.horaSalida.split(":").map(Number);
        horaFinMin = hs * 60 + ms;
      } else if (turno && esTurnoValido(turno)) {
        horaFinMin = (horaInicioTurno(turno) + horasPorTurno(turno) + 1) * 60; // +1h de almuerzo
      } else {
        horaFinMin = ev.ENTRADA + 8 * 60; // sin turno identificable: 8h después de la entrada, como respaldo
      }
      horaFinMin = horaFinMin % (24 * 60);
      const horaFinTexto = String(Math.floor(horaFinMin / 60)).padStart(2, "0") + ":" + String(horaFinMin % 60).padStart(2, "0") + ":00";

      const empleado = empleados.find(e => e.codigo === codigo);
      hoja.appendRow([
        new Date(),
        "'" + fecha,
        "'" + horaFinTexto,
        codigo,
        empleado ? empleado.nombre : codigo,
        "SALIDA",
        "", "", "",
        "CIERRE_AUTOMATICO: no marcó Salida el " + fecha + " — el sistema lo cerró solo al final del turno esperado (" + horaFinTexto.slice(0, 5) + "). Revisa con la persona qué pasó ese día.",
        ""
      ]);
      cerrados++;
    });
  });

  return cerrados;
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
    return Utilities.formatDate(valor, ZONA_HORARIA_MONTANA, "yyyy-MM-dd");
  }
  return String(valor).trim().replace(/^'/, "");
}

function respuestaJson(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------
// Módulo de Liquidación — Prima, Vacaciones, Liquidación final.
// Colombia liquida sobre el "año comercial" de 360 días (12 meses de 30
// días cada uno) — por eso los días entre dos fechas NO se cuentan como
// calendario real, sino con esta convención fija.
// ---------------------------------------------------------
function diasComercialesEntre(fechaInicioStr, fechaFinStr) {
  const [aI, mI, dIReal] = fechaInicioStr.split("-").map(Number);
  const [aF, mF, dFReal] = fechaFinStr.split("-").map(Number);
  const dI = Math.min(dIReal, 30);
  const dF = Math.min(dFReal, 30);
  return (aF - aI) * 360 + (mF - mI) * 30 + (dF - dI) + 1; // +1 incluye ambos extremos
}

function obtenerFechaIngresoTexto(emp) {
  if (!emp.fechaIngreso) return "";
  return normalizarFecha(emp.fechaIngreso);
}

// Prima de servicios: (salario × días trabajados en el semestre) / 360.
// semestre 1 = ene-jun (se paga antes del 30 de junio), 2 = jul-dic (antes del 20 de diciembre).
function calcularPrima(codigo, anio, semestre) {
  const emp = obtenerEmpleadosActivosConSalario().find(e => e.codigo === codigo);
  if (!emp) return { error: "Código no encontrado" };
  if (!emp.salarioMensual) return { error: "Esta persona no tiene salario cargado en Empleados" };

  const inicioSemestre = semestre === 1 ? (anio + "-01-01") : (anio + "-07-01");
  const finSemestre = semestre === 1 ? (anio + "-06-30") : (anio + "-12-31");

  let inicioReal = inicioSemestre;
  const fechaIngreso = obtenerFechaIngresoTexto(emp);
  if (fechaIngreso && fechaIngreso > inicioSemestre) inicioReal = fechaIngreso;

  if (fechaIngreso && fechaIngreso > finSemestre) {
    return { error: "Esta persona ingresó después de terminar ese semestre — no hay prima que liquidar todavía." };
  }

  const diasTrabajados = Math.max(0, Math.min(diasComercialesEntre(inicioReal, finSemestre), 180));
  const valorPrima = Math.round((emp.salarioMensual * diasTrabajados) / 360);
  const salud = Math.round(valorPrima * 0.04);
  const pension = Math.round(valorPrima * 0.04);

  return {
    codigo: emp.codigo, nombre: emp.nombre, cargo: emp.cargo, salarioMensual: emp.salarioMensual,
    periodoInicio: inicioReal, periodoFin: finSemestre, diasTrabajados: diasTrabajados,
    valorPrima: valorPrima, salud: salud, pension: pension, totalDeducciones: salud + pension,
    netoAPagar: valorPrima - salud - pension
  };
}

// Vacaciones: 15 días hábiles por cada 360 días trabajados.
// Valor a pagar = (salario × días trabajados en el período) / 720.
function calcularVacaciones(codigo, fechaInicio, fechaFin) {
  const emp = obtenerEmpleadosActivosConSalario().find(e => e.codigo === codigo);
  if (!emp) return { error: "Código no encontrado" };
  if (!emp.salarioMensual) return { error: "Esta persona no tiene salario cargado en Empleados" };
  if (fechaFin < fechaInicio) return { error: "La fecha final debe ser posterior a la inicial" };

  const diasTrabajados = diasComercialesEntre(fechaInicio, fechaFin);
  const diasVacacionesAcumulados = Math.round((diasTrabajados * 15 / 360) * 100) / 100;
  const valorVacaciones = Math.round((emp.salarioMensual * diasTrabajados) / 720);
  // Nota: las vacaciones NO llevan descuento de salud/pensión aparte —
  // ya se cotizó sobre ellas en el salario del período en que se disfrutan
  // (el empleado sigue devengando su salario normal esos días).

  return {
    codigo: emp.codigo, nombre: emp.nombre, cargo: emp.cargo, salarioMensual: emp.salarioMensual,
    periodoInicio: fechaInicio, periodoFin: fechaFin, diasTrabajados: diasTrabajados,
    diasVacacionesAcumulados: diasVacacionesAcumulados, valorVacaciones: valorVacaciones
  };
}

// Cesantías (Art. 249 CST): se consignan anualmente antes del 14 de
// febrero, por el año calendario que acaba de terminar (o proporcional si
// la persona ingresó durante ese año, o si el año todavía no ha terminado).
// Fórmula: (salario × días trabajados en el año) / 360.
function calcularCesantias(codigo, anio) {
  const emp = obtenerEmpleadosActivosConSalario().find(e => e.codigo === codigo);
  if (!emp) return { error: "Código no encontrado" };
  if (!emp.salarioMensual) return { error: "Esta persona no tiene salario cargado en Empleados" };
  const fechaIngreso = obtenerFechaIngresoTexto(emp);
  if (!fechaIngreso) return { error: "Falta la Fecha_Ingreso de esta persona en la pestaña Empleados" };

  let inicioAnio = anio + "-01-01";
  if (fechaIngreso > inicioAnio) inicioAnio = fechaIngreso;
  const finAnioReal = anio + "-12-31";
  const hoy = Utilities.formatDate(new Date(), ZONA_HORARIA_MONTANA, "yyyy-MM-dd");
  const finAnio = finAnioReal < hoy ? finAnioReal : hoy; // no cuenta días futuros si el año no ha terminado

  if (inicioAnio > finAnio) {
    return { codigo: emp.codigo, nombre: emp.nombre, anio: anio, dias: 0, valorCesantias: 0, interesesCesantias: 0, periodoInicio: inicioAnio, periodoFin: finAnio };
  }

  const dias = diasComercialesEntre(inicioAnio, finAnio);
  const valorCesantias = Math.round((emp.salarioMensual * dias) / 360);
  const interesesCesantias = Math.round(valorCesantias * (dias / 360) * 0.12);

  return {
    codigo: emp.codigo, nombre: emp.nombre, cargo: emp.cargo, salarioMensual: emp.salarioMensual,
    anio: anio, periodoInicio: inicioAnio, periodoFin: finAnio, dias: dias,
    valorCesantias: valorCesantias, interesesCesantias: interesesCesantias,
    fechaLimitePago: (anio + 1) + "-02-14"
  };
}

// Liquidación final: prestaciones sociales proporcionales al momento del
// retiro. NO incluye indemnización por despido injustificado — eso depende
// de la causa del retiro y del tipo de contrato, y debe validarse con un
// abogado o contador antes de pagar.
function calcularLiquidacionFinal(codigo, fechaRetiro) {
  const emp = obtenerEmpleadosActivosConSalario().find(e => e.codigo === codigo);
  if (!emp) return { error: "Código no encontrado" };
  if (!emp.salarioMensual) return { error: "Esta persona no tiene salario cargado en Empleados" };
  const fechaIngreso = obtenerFechaIngresoTexto(emp);
  if (!fechaIngreso) return { error: "Falta la Fecha_Ingreso de esta persona en la pestaña Empleados" };
  if (fechaRetiro < fechaIngreso) return { error: "La fecha de retiro no puede ser anterior a la fecha de ingreso" };

  const diasTotalesTrabajados = diasComercialesEntre(fechaIngreso, fechaRetiro);

  // Cesantías: proporcional desde el 1 de enero del año de retiro (o desde el ingreso, si fue ese mismo año)
  const anioRetiro = Number(fechaRetiro.slice(0, 4));
  let inicioCesantias = anioRetiro + "-01-01";
  if (fechaIngreso > inicioCesantias) inicioCesantias = fechaIngreso;
  const diasCesantias = diasComercialesEntre(inicioCesantias, fechaRetiro);
  const cesantias = Math.round((emp.salarioMensual * diasCesantias) / 360);
  const interesesCesantias = Math.round(cesantias * (diasCesantias / 360) * 0.12);

  // Prima proporcional del semestre en curso al momento del retiro
  const mesRetiro = Number(fechaRetiro.slice(5, 7));
  const semestreActual = mesRetiro <= 6 ? 1 : 2;
  let inicioPrima = semestreActual === 1 ? (anioRetiro + "-01-01") : (anioRetiro + "-07-01");
  if (fechaIngreso > inicioPrima) inicioPrima = fechaIngreso;
  const diasPrima = diasComercialesEntre(inicioPrima, fechaRetiro);
  const primaProporcional = Math.round((emp.salarioMensual * diasPrima) / 360);

  // Vacaciones proporcionales de toda la relación laboral (ajusta si ya se pagaron antes)
  const diasVacacionesAcumulados = Math.round((diasTotalesTrabajados * 15 / 360) * 100) / 100;
  const vacaciones = Math.round((emp.salarioMensual * diasTotalesTrabajados) / 720);

  // Deducciones: salud y pensión (4% + 4%) sobre el total devengado de la liquidación,
  // igual que en cualquier pago de nómina — muchos contadores NO descuentan sobre
  // cesantías ni sus intereses (están exentos), así que la base de deducción es
  // solo prima proporcional + vacaciones proporcionales.
  const baseDeduccion = primaProporcional + vacaciones;
  const salud = Math.round(baseDeduccion * 0.04);
  const pension = Math.round(baseDeduccion * 0.04);
  const totalDeducciones = salud + pension;

  const totalDevengado = cesantias + interesesCesantias + primaProporcional + vacaciones;
  const totalLiquidacion = totalDevengado - totalDeducciones;

  return {
    codigo: emp.codigo, nombre: emp.nombre, cargo: emp.cargo, salarioMensual: emp.salarioMensual,
    fechaIngreso: fechaIngreso, fechaRetiro: fechaRetiro, diasTotalesTrabajados: diasTotalesTrabajados,
    cesantias: cesantias, cesantiasDesde: inicioCesantias, diasCesantias: diasCesantias,
    interesesCesantias: interesesCesantias,
    primaProporcional: primaProporcional, primaDesde: inicioPrima, diasPrimaProporcional: diasPrima,
    vacaciones: vacaciones, diasVacacionesAcumulados: diasVacacionesAcumulados,
    salud: salud, pension: pension, totalDeducciones: totalDeducciones,
    totalDevengado: totalDevengado, totalLiquidacion: totalLiquidacion,
    aviso: "No incluye indemnización por despido injustificado — valida la causa del retiro con tu abogado o contador antes de pagar."
  };
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
      horaEntrada: normalizarHora(filas[i][2]),
      horaSalida: normalizarHora(filas[i][3]),
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
  const novedadesRango = obtenerNovedadesRango(fecha, fecha);
  const excepcionesRango = obtenerExcepcionesRango(fecha, fecha);

  const hoja = obtenerHoja(NOMBRE_HOJA_REGISTRO);
  const filas = hoja.getDataRange().getValues();
  const zona = ZONA_HORARIA_MONTANA;

  const porEmpleado = {};
  for (let i = 1; i < filas.length; i++) {
    const filaFecha = normalizarFecha(filas[i][1]);
    if (filaFecha !== fecha) continue;
    const codigo = filas[i][3];
    const tipo = filas[i][5];
    const horaCelda = filas[i][2];
    const hora = (horaCelda instanceof Date) ? Utilities.formatDate(horaCelda, zona, "HH:mm:ss") : String(horaCelda).trim().replace(/^'/, "");
    const observaciones = String(filas[i][9] || "");
    const esAjuste = observaciones.indexOf("AJUSTE_MANUAL") !== -1;

    if (!porEmpleado[codigo]) porEmpleado[codigo] = [];
    porEmpleado[codigo].push({ tipo: tipo, hora: hora, observaciones: observaciones, ajuste: esAjuste });
  }
  Object.keys(porEmpleado).forEach(cod => porEmpleado[cod].sort((a, b) => a.hora < b.hora ? -1 : (a.hora > b.hora ? 1 : 0)));

  const resultado = empleados.map(emp => {
    const turnoNormal = (horarioSemanal[emp.codigo] || {})[diaNombre] || "LIBRE";
    const excepcion = (excepcionesRango[emp.codigo] && excepcionesRango[emp.codigo][fecha]) || null;
    const novedadesDelDia = novedadesRango[emp.codigo] && novedadesRango[emp.codigo][fecha];
    return {
      codigo: emp.codigo, nombre: emp.nombre, cargo: emp.cargo,
      turnoProgramado: turnoNormal,
      excepcion: excepcion,
      novedad: novedadesDelDia || null,
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
      let parcial = null;
      let almuerzoNoMarcado = false;
      if (ev.ENTRADA !== undefined && ev.SALIDA !== undefined) {
        let minutosTrabajados = ev.SALIDA - ev.ENTRADA;
        if (ev.SALIDA_ALMUERZO !== undefined) {
          // Si marcó que salió a almorzar pero nunca marcó el regreso, se
          // asume 0 minutos de almuerzo real marcado — igual se estira al
          // mínimo acordado (el mismo cálculo de construirIntervalosTrabajo).
          const regresoReal = ev.REGRESO_ALMUERZO !== undefined ? ev.REGRESO_ALMUERZO : ev.SALIDA_ALMUERZO;
          const almuerzoReal = regresoReal - ev.SALIDA_ALMUERZO;
          minutosTrabajados -= Math.max(almuerzoReal, MINUTOS_MINIMOS_ALMUERZO);
          if (ev.REGRESO_ALMUERZO === undefined) almuerzoNoMarcado = true; // marcó salida, pero no el regreso
        } else {
          // Fue directo de Entrada a Salida sin marcar ningún almuerzo — se
          // descuenta igual el mínimo acordado, para no pagarle de más.
          minutosTrabajados -= MINUTOS_MINIMOS_ALMUERZO;
          almuerzoNoMarcado = true;
        }
        horas = Math.round((Math.max(0, minutosTrabajados) / 60) * 100) / 100;
        incompleto = false;
      } else if (ev.ENTRADA !== undefined) {
        // Todavía no ha marcado salida — el frontend usa esto para mostrar
        // cuánto lleva trabajado hasta el momento (solo tiene sentido para hoy).
        parcial = {
          entradaMin: ev.ENTRADA,
          salidaAlmuerzoMin: ev.SALIDA_ALMUERZO !== undefined ? ev.SALIDA_ALMUERZO : null,
          regresoAlmuerzoMin: ev.REGRESO_ALMUERZO !== undefined ? ev.REGRESO_ALMUERZO : null
        };
      }

      const diaNombre = DIAS_SEMANA_LUN_A_DOM[diaDeSemanaLunesA0(fecha)];
      const turno = (horarioSemanal[codigo] || {})[diaNombre] || "LIBRE";
      const ajustado = ev._ajustado === true;
      const cierreAutomatico = ev._cierreAutomatico === true;
      const horasEsperadasDia = esTurnoValido(turno) ? horasPorTurno(turno) : HORAS_PAGAS_POR_TURNO;
      const horasExtraDia = horas !== null ? Math.max(0, Math.round((horas - horasEsperadasDia) * 100) / 100) : 0;
      const excepcionDia = (excepciones[fecha] && excepciones[fecha][codigo]) || null;

      if (!diario[fecha]) diario[fecha] = {};
      diario[fecha][codigo] = { horas: horas, incompleto: incompleto, turno: turno, ajustado: ajustado, cierreAutomatico: cierreAutomatico, horasExtra: horasExtraDia, excepcion: excepcionDia, parcial: parcial, almuerzoNoMarcado: almuerzoNoMarcado };

      if (horas !== null) {
        mensual[codigo] = Math.round(((mensual[codigo] || 0) + horas) * 100) / 100;
        mensualExtra[codigo] = Math.round(((mensualExtra[codigo] || 0) + horasExtraDia) * 100) / 100;

        if (esTurnoValido(turno) && jornadaDeTurno(turno) === "36" && horasExtraDia > 0) {
          const emp = empleados.find(e => e.codigo === codigo);
          alertasLegales.push({
            tipo: "VIOLACION_6X6", codigo: codigo, nombre: emp ? emp.nombre : codigo,
            fecha: fecha, horasExtra: horasExtraDia, limite: 0
          });
        } else if (horasExtraDia > LIMITE_EXTRA_DIARIA_HORAS) {
          const emp = empleados.find(e => e.codigo === codigo);
          if (!emp || !emp.esConfianza) {
            alertasLegales.push({
              tipo: "DIARIA", codigo: codigo, nombre: emp ? emp.nombre : codigo,
              fecha: fecha, horasExtra: horasExtraDia, limite: LIMITE_EXTRA_DIARIA_HORAS
            });
          }
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
      const empleadoEs36 = empleadoTieneJornada36(codigo, horarioSemanal);
      const topeReal = empleadoEs36 ? 36 : tope;
      if (horas > topeReal) {
        const emp = empleados.find(e => e.codigo === codigo);
        if (emp && emp.esConfianza) return; // los cargos de confianza y manejo no tienen jornada máxima (Art. 162 CST)
        const horasExtraSemana = Math.round((horas - topeReal) * 100) / 100;
        alertas42.push({
          codigo: codigo, nombre: emp ? emp.nombre : codigo,
          semanaKey: semanaKey, horas: horas, tope: topeReal, horasExtra: horasExtraSemana
        });
        // Para 6x6, cualquier exceso semanal es una violación del esquema
        // (no está permitido que compense con horas extra), por eso el
        // límite se marca directamente en 0 en vez de los 12h de la jornada normal.
        const limiteSemanal36 = 0;
        if (empleadoEs36 ? horasExtraSemana > limiteSemanal36 : horasExtraSemana > LIMITE_EXTRA_SEMANAL_HORAS) {
          alertasLegales.push({
            tipo: empleadoEs36 ? "VIOLACION_6X6" : "SEMANAL", codigo: codigo, nombre: emp ? emp.nombre : codigo,
            semanaKey: semanaKey, horasExtra: horasExtraSemana, limite: empleadoEs36 ? limiteSemanal36 : LIMITE_EXTRA_SEMANAL_HORAS
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
  // El panel pide esto 2 veces seguidas (una para "Nómina", otra para
  // "Recargos"), cada una en una petición HTTP separada que no puede
  // compartir memoria — por eso usamos una caché corta (30s) para no leer
  // toda la hoja "Registro" dos veces en la misma carga y que sea más rápido.
  const cache = CacheService.getScriptCache();
  const claveCache = "eventos_" + mesTexto + "_" + (fechaInicio || "") + "_" + (fechaFin || "");
  try {
    const cacheado = cache.get(claveCache);
    if (cacheado) return JSON.parse(cacheado);
  } catch (errorCache) { /* si falla la caché, seguimos y calculamos normal */ }

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
    const esCierreAutomatico = observaciones.indexOf("CIERRE_AUTOMATICO") !== -1;

    if (!eventos[codigo]) eventos[codigo] = {};
    if (!eventos[codigo][fecha]) eventos[codigo][fecha] = {};
    if (!vieneDeAjuste[codigo]) vieneDeAjuste[codigo] = {};
    if (!vieneDeAjuste[codigo][fecha]) vieneDeAjuste[codigo][fecha] = {};

    const yaEsAjuste = vieneDeAjuste[codigo][fecha][tipo] === true;
    if (yaEsAjuste && !esAjuste) continue; // un ajuste vigente no se deja pisar por una marca normal

    if (esCierreAutomatico) eventos[codigo][fecha]._cierreAutomatico = true;
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
  try {
    cache.put(claveCache, JSON.stringify(eventos), 30);
  } catch (errorCache) { /* si la hoja es muy grande para cachear, no pasa nada, sigue funcionando sin caché */ }

  return eventos;
}

function obtenerEmpleadosActivosConCargo() {
  const hoja = obtenerHoja(NOMBRE_HOJA_EMPLEADOS);
  const filas = hoja.getDataRange().getValues();
  const encabezados = filas[0];
  const colConfianza = encabezados.indexOf("Cargo_Confianza");
  const colTipoPersonal = encabezados.indexOf("Tipo_Personal");
  const resultado = [];
  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    if (fila[0] && fila[3] === true) {
      resultado.push({
        codigo: fila[0], nombre: fila[1], cargo: fila[4],
        esConfianza: colConfianza > -1 && fila[colConfianza] === true,
        tipoPersonal: (colTipoPersonal > -1 && String(fila[colTipoPersonal]).toUpperCase().trim() === "TURNO") ? "TURNO" : "PLANTA"
      });
    }
  }
  return resultado;
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
  // horaStr viene como "HH:mm:ss" (texto) o como objeto Date de Sheets.
  // Usamos formatDate con la zona fija en vez de getHours()/getMinutes()
  // directos, porque esos dependen del huso horario del proyecto de Apps
  // Script (no del nuestro), y para fechas "ancla" como 30-dic-1899 que usa
  // Sheets para valores de solo-hora, esa diferencia puede desfasar el dato.
  if (horaStr instanceof Date) {
    const formateada = Utilities.formatDate(horaStr, ZONA_HORARIA_MONTANA, "HH:mm");
    const partes = formateada.split(":");
    return parseInt(partes[0], 10) * 60 + parseInt(partes[1], 10);
  }
  const partes = String(horaStr).trim().replace(/^'/, "").split(":");
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
  return Utilities.formatDate(d, ZONA_HORARIA_MONTANA, "yyyy-MM-dd");
}

// ===========================================================
// RECARGOS Y NÓMINA — base para nómina electrónica
// ===========================================================
// ⚠️ Esta clasificación (diurno/nocturno/extra/dominical-festivo)
// sigue las reglas generales de la legislación laboral colombiana.
// Antes de usarla para pagar nómina real, pídele a tu contador que
// valide las tasas y la lista de festivos del año en curso.


// Devuelve el rango real de fechas del período (para poder recorrer día a día).
function obtenerRangoFechasPeriodo(mesTexto, fechaInicio, fechaFin) {
  if (fechaInicio && fechaFin) return { inicio: fechaInicio, fin: fechaFin };
  const anio = Number(mesTexto.slice(0, 4)), mes = Number(mesTexto.slice(5, 7));
  const ultimoDiaReal = new Date(anio, mes, 0).getDate();
  // Colombia liquida el mes comercial de 30 días — el sueldo fijo mensual no
  // cambia entre un mes de 28, 30 o 31 días, así que el día 31 (si existe)
  // no debe generar ni horas ordinarias ni extra aparte: ya está cubierto
  // por el sueldo fijo. Por eso el rango nunca pasa del día 30.
  const ultimoDia = Math.min(ultimoDiaReal, 30);
  return { inicio: mesTexto + "-01", fin: mesTexto + "-" + String(ultimoDia).padStart(2, "0") };
}

// ---------------------------------------------------------
// Recorre día por día el período y compara lo que le tocaba
// trabajar a la persona (según su horario o una excepción)
// contra lo que realmente trabajó. Descuenta:
//   - Días completos sin ninguna marca (ausencia injustificada)
//   - Minutos faltantes cuando SÍ marcó pero trabajó menos de
//     las horas de su turno (ej: llega 10 min tarde varios días
//     seguidos, o se va antes) — esto se va acumulando.
// Los días con una Novedad registrada (incapacidad, permiso,
// vacaciones) NO se descuentan.
// ---------------------------------------------------------
function calcularHorasNoTrabajadasPeriodo(codigo, rango, horarioSemanal, eventosCodigo, novedadesCodigo, excepcionesCodigo) {
  let horasFaltantes = 0;
  let diasAusencia = 0;
  let diasIncompletos = 0;
  let diasConNovedad = 0;
  let diasTrabajados = 0;
  const fechasAusenciaSinMarcar = []; // fechas exactas donde debía trabajar y no marcó nada, sin novedad
  const semanasConAusencia = {}; // semanaKey (lunes) -> true si esa semana tuvo al menos 1 ausencia injustificada

  const inicio = new Date(rango.inicio + "T00:00:00");
  const fin = new Date(rango.fin + "T00:00:00");
  const zona = ZONA_HORARIA_MONTANA;

  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) {
    const fechaStr = Utilities.formatDate(d, zona, "yyyy-MM-dd");
    const diaNombre = DIAS_SEMANA_LUN_A_DOM[diaDeSemanaLunesA0(fechaStr)];

    const excepcion = excepcionesCodigo && excepcionesCodigo[fechaStr];
    const turnoNormal = (horarioSemanal[codigo] || {})[diaNombre] || "LIBRE";
    const debiaTrabajar = !!excepcion || esTurnoValido(turnoNormal);
    if (!debiaTrabajar) continue;
    const horasEsperadasHoy = excepcion ? HORAS_PAGAS_POR_TURNO : horasPorTurno(turnoNormal);

    const novedadDelDia = novedadesCodigo && novedadesCodigo[fechaStr];
    if (novedadDelDia && novedadDelDia.estado !== "SIN_SOPORTE_DESCONTAR") {
      // PENDIENTE, VALIDADA_SOPORTE o SOLICITAR_EPS: no se descuenta (beneficio
      // de la duda hasta que un socio la marque explícitamente sin soporte).
      diasConNovedad++;
      continue;
    }
    // Si la novedad quedó marcada SIN_SOPORTE_DESCONTAR, sigue de largo y
    // el día se evalúa igual que una ausencia normal (si aplica, se descuenta).

    const ev = eventosCodigo[fechaStr];
    let horasTrabajadas = 0;
    if (ev && ev.ENTRADA !== undefined && ev.SALIDA !== undefined) {
      let minutos = ev.SALIDA - ev.ENTRADA;
      if (ev.SALIDA_ALMUERZO !== undefined) {
        const regresoReal = ev.REGRESO_ALMUERZO !== undefined ? ev.REGRESO_ALMUERZO : ev.SALIDA_ALMUERZO;
        const almuerzoReal = regresoReal - ev.SALIDA_ALMUERZO;
        minutos -= Math.max(almuerzoReal, MINUTOS_MINIMOS_ALMUERZO);
      } else {
        minutos -= MINUTOS_MINIMOS_ALMUERZO;
      }
      horasTrabajadas = Math.max(0, minutos) / 60;
    }
    if (horasTrabajadas > 0) diasTrabajados++;

    const deficit = Math.max(0, horasEsperadasHoy - horasTrabajadas);
    if (deficit > 0) {
      horasFaltantes += deficit;
      if (horasTrabajadas === 0) {
        diasAusencia++;
        fechasAusenciaSinMarcar.push(fechaStr);
        semanasConAusencia[lunesDeSemana(fechaStr)] = true; // ausencia completa injustificada esa semana
      } else {
        diasIncompletos++;
      }
    }
  }

  // Art. 173 CST: quien no trabajó todos los días hábiles de la semana (sin
  // justificación) pierde el derecho al pago del día de descanso remunerado
  // de esa semana — se descuenta un día adicional por cada semana afectada
  // (7h para jornada de 42h; para 6x6 este esquema ya incluye el descanso
  // dentro del sueldo fijo semanal, así que solo aplica a la jornada de 42h).
  const semanasSinDescanso = Object.keys(semanasConAusencia).length;
  const horasDescansoPerdido = semanasSinDescanso * HORAS_PAGAS_POR_TURNO;
  horasFaltantes += horasDescansoPerdido;

  return {
    horasFaltantes: Math.round(horasFaltantes * 100) / 100,
    diasAusencia: diasAusencia,
    diasIncompletos: diasIncompletos,
    diasConNovedad: diasConNovedad,
    diasTrabajados: diasTrabajados,
    semanasSinDescanso: semanasSinDescanso,
    horasDescansoPerdido: Math.round(horasDescansoPerdido * 100) / 100,
    fechasAusenciaSinMarcar: fechasAusenciaSinMarcar
  };
}

function calcularResumenNomina(mesTexto, fechaInicio, fechaFin, divisorHorasPeriodo) {
  const empleados = obtenerEmpleadosActivosConSalario();
  const rango = obtenerRangoFechasPeriodo(mesTexto, fechaInicio, fechaFin); // ya limita el mes completo a 30 días
  const eventos = construirEventosPorDia(mesTexto, rango.inicio, rango.fin);
  const divisor = divisorHorasPeriodo || DIVISOR_HORAS_MES;
  const fraccionPeriodo = divisor / DIVISOR_HORAS_MES; // 1 = mes completo, 0.5 = quincena

  const horarioSemanal = obtenerHorarioSemanalCompleto();
  const novedadesRango = obtenerNovedadesRango(rango.inicio, rango.fin);
  const excepcionesRango = obtenerExcepcionesRango(rango.inicio, rango.fin);

  const bucketsVacios = () => ({
    diurnoOrd: 0, nocturnoOrd: 0, diurnoExtra: 0, nocturnoExtra: 0,
    festDiurnoOrd: 0, festNocturnoOrd: 0, festDiurnoExtra: 0, festNocturnoExtra: 0
  });

  const resultado = {};
  const diasTrabajadosPorCodigo = {}; // { diasOrdinarios, diasDomFest } — para pagar a los turneros por día
  const horas36PorCodigo = {}; // { horasSinRecargo, diasConViolacion } — para empleados en jornada 6x6
  empleados.forEach(emp => {
    resultado[emp.codigo] = bucketsVacios();
    diasTrabajadosPorCodigo[emp.codigo] = { diasOrdinarios: 0, diasDomFest: 0 };
    horas36PorCodigo[emp.codigo] = { horasSinRecargo: 0, diasConViolacion: [] };
  });

  Object.keys(eventos).forEach(codigo => {
    if (!resultado[codigo]) resultado[codigo] = bucketsVacios();
    if (!diasTrabajadosPorCodigo[codigo]) diasTrabajadosPorCodigo[codigo] = { diasOrdinarios: 0, diasDomFest: 0 };
    if (!horas36PorCodigo[codigo]) horas36PorCodigo[codigo] = { horasSinRecargo: 0, diasConViolacion: [] };

    Object.keys(eventos[codigo]).forEach(fecha => {
      const ev = eventos[codigo][fecha];
      if (ev.ENTRADA === undefined || ev.SALIDA === undefined) return; // registro incompleto, se omite

      // ¿Qué turno tenía programado ESE día? De ahí se sabe si es jornada de
      // 42h (con recargo normal) o de 36h/6x6 (sin recargo nocturno ni
      // dominical/festivo, Art. 161 CST, pero con tope estricto de 6h/día).
      const diaNombreEv = DIAS_SEMANA_LUN_A_DOM[diaDeSemanaLunesA0(fecha)];
      const excepcionDia = excepcionesRango[codigo] && excepcionesRango[codigo][fecha];
      const turnoDelDia = excepcionDia ? null : ((horarioSemanal[codigo] || {})[diaNombreEv] || "LIBRE");
      const esJornada36 = turnoDelDia && jornadaDeTurno(turnoDelDia) === "36";

      const intervalos = construirIntervalosTrabajo(ev.ENTRADA, ev.SALIDA, ev.SALIDA_ALMUERZO, ev.REGRESO_ALMUERZO);

      if (esJornada36) {
        // Jornada 6x6: se paga TODO a tarifa plana, sin ningún recargo —
        // ni nocturno, ni dominical/festivo (esa es la condición legal del
        // esquema). Si algún día supera las horas del turno (6h), es una
        // violación de las condiciones del esquema, no "horas extra a pagar".
        let minutosDia = 0;
        intervalos.forEach(([ini, fin]) => { minutosDia += (fin - ini); });
        const horasDia = minutosDia / 60;
        horas36PorCodigo[codigo].horasSinRecargo += horasDia;
        const topeTurno36 = horasPorTurno(turnoDelDia);
        if (horasDia > topeTurno36 + 0.01) {
          horas36PorCodigo[codigo].diasConViolacion.push({ fecha: fecha, horas: Math.round(horasDia*100)/100, tope: topeTurno36 });
        }
        const esFestivoDia = esFestivoODomingo(fecha);
        if (esFestivoDia) diasTrabajadosPorCodigo[codigo].diasDomFest++; else diasTrabajadosPorCodigo[codigo].diasOrdinarios++;
        return; // no pasa por el desglose normal de recargos
      }

      const desglose = desglosarMinutosDelDia(intervalos);
      const esFestivo = esFestivoODomingo(fecha);

      const acc = resultado[codigo];
      if (esFestivo) {
        acc.festDiurnoOrd += desglose.diurnoOrd;
        acc.festNocturnoOrd += desglose.nocturnoOrd;
        acc.festDiurnoExtra += desglose.diurnoExtra;
        acc.festNocturnoExtra += desglose.nocturnoExtra;
        diasTrabajadosPorCodigo[codigo].diasDomFest++;
      } else {
        acc.diurnoOrd += desglose.diurnoOrd;
        acc.nocturnoOrd += desglose.nocturnoOrd;
        acc.diurnoExtra += desglose.diurnoExtra;
        acc.nocturnoExtra += desglose.nocturnoExtra;
        diasTrabajadosPorCodigo[codigo].diasOrdinarios++;
      }
    });
  });

  // Redondear a 2 decimales y calcular valor en pesos si hay salario
  const detalle = empleados.map(emp => {
    const h = resultado[emp.codigo];
    Object.keys(h).forEach(k => h[k] = Math.round(h[k] * 100) / 100);

    const infoFaltante = calcularHorasNoTrabajadasPeriodo(
      emp.codigo, rango, horarioSemanal, eventos[emp.codigo] || {}, novedadesRango[emp.codigo] || {}, excepcionesRango[emp.codigo] || {}
    );

    let valorHora = null;
    let valorTotal = null;
    const horas36Info = horas36PorCodigo[emp.codigo] || { horasSinRecargo: 0, diasConViolacion: [] };
    const horas36Redondeadas = Math.round(horas36Info.horasSinRecargo * 100) / 100;
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
        h.festNocturnoExtra * valorHora * (1 + RECARGO_DOMINICAL_FESTIVO + RECARGO_EXTRA_NOCTURNA) +
        horas36Redondeadas * valorHora * 1 // jornada 6x6: siempre tarifa plana, sin ningún recargo
      );
    }

    // Turneros de Cocina/Salón: NO tienen sueldo fijo mensual — se les paga
    // únicamente por los días que trabajaron, y ese día se paga distinto según
    // sea ordinario o dominical/festivo (Art. 179 CST, recargo dominical/festivo).
    const diasInfo = diasTrabajadosPorCodigo[emp.codigo] || { diasOrdinarios: 0, diasDomFest: 0 };
    let valorDiaOrdinario = null, valorDiaDomFest = null, valorPorDias = null, auxTransporteFinal;
    if (emp.tipoPersonal === "TURNO" && emp.salarioMensual > 0) {
      valorDiaOrdinario = Math.round(emp.salarioMensual / 30);
      valorDiaDomFest = Math.round(valorDiaOrdinario * (1 + RECARGO_DOMINICAL_FESTIVO));
      valorPorDias = (diasInfo.diasOrdinarios * valorDiaOrdinario) + (diasInfo.diasDomFest * valorDiaDomFest);
      // El auxilio de transporte de un turnero es proporcional a los días
      // realmente trabajados, no a una fracción fija del mes/quincena.
      auxTransporteFinal = Math.round(((emp.auxilioTransporte || 0) / 30) * (diasInfo.diasOrdinarios + diasInfo.diasDomFest));
    } else {
      auxTransporteFinal = Math.round((emp.auxilioTransporte || 0) * fraccionPeriodo);
    }

    return {
      codigo: emp.codigo, nombre: emp.nombre, cargo: emp.cargo, esConfianza: emp.esConfianza,
      tipoPersonal: emp.tipoPersonal,
      horas: h, valorHora: valorHora, valorTotal: valorTotal,
      auxilioTransporte: auxTransporteFinal,
      diasOrdinariosTrabajados: diasInfo.diasOrdinarios, diasDomFestTrabajados: diasInfo.diasDomFest,
      valorDiaOrdinario: valorDiaOrdinario, valorDiaDomFest: valorDiaDomFest, valorPorDiasTrabajados: valorPorDias,
      horas36: horas36Redondeadas, violaciones36: horas36Info.diasConViolacion,
      esJornada36: empleadoTieneJornada36(emp.codigo, horarioSemanal),
      cedula: emp.cedula, direccion: emp.direccion, email: emp.email, telefono: emp.telefono,
      eps: emp.eps, afp: emp.afp, arl: emp.arl, banco: emp.banco, cuenta: emp.cuenta,
      horasNoTrabajadas: infoFaltante.horasFaltantes,
      diasAusencia: infoFaltante.diasAusencia,
      diasIncompletos: infoFaltante.diasIncompletos,
      diasConNovedad: infoFaltante.diasConNovedad,
      fechasAusenciaSinMarcar: infoFaltante.fechasAusenciaSinMarcar,
      diasTrabajados: infoFaltante.diasTrabajados,
      semanasSinDescanso: infoFaltante.semanasSinDescanso,
      horasDescansoPerdido: infoFaltante.horasDescansoPerdido
    };
  });

  // Listado plano de novedades del período (para revisar antes de cerrar la nómina)
  const novedadesDelPeriodo = [];
  Object.keys(novedadesRango).forEach(codigo => {
    const emp = empleados.find(e => e.codigo === codigo);
    Object.keys(novedadesRango[codigo]).forEach(fecha => {
      const n = novedadesRango[codigo][fecha];
      novedadesDelPeriodo.push({
        codigo: codigo, nombre: emp ? emp.nombre : codigo, fecha: fecha,
        tipo: n.tipo, motivo: n.motivo, estado: n.estado, autorizadoPor: n.autorizadoPor
      });
    });
  });

  // También se incluyen los días donde alguien debía trabajar y no marcó
  // nada, y no tiene ninguna novedad registrada que lo justifique — esto
  // necesita que el administrador lo revise antes de cerrar la nómina
  // (¿estaba enfermo y no avisó? ¿se le olvidó marcar? ¿no debía trabajar?).
  detalle.forEach(d => {
    (d.fechasAusenciaSinMarcar || []).forEach(fecha => {
      const yaTieneNovedad = novedadesRango[d.codigo] && novedadesRango[d.codigo][fecha];
      if (yaTieneNovedad) return; // ya está cubierto arriba
      novedadesDelPeriodo.push({
        codigo: d.codigo, nombre: d.nombre, fecha: fecha,
        tipo: "AUSENCIA_SIN_MARCAR", motivo: "No hay ningún registro de marcación ese día y no tiene novedad justificada.",
        estado: "PENDIENTE"
      });
    });
  });

  novedadesDelPeriodo.sort((a, b) => a.fecha < b.fecha ? -1 : 1);

  return {
    detalle: detalle,
    novedadesDelPeriodo: novedadesDelPeriodo,
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
  const colConfianza = col("Cargo_Confianza");
  const colTipoPersonal = col("Tipo_Personal");

  const leer = (fila, colIdx) => (colIdx > -1 && fila[colIdx]) ? fila[colIdx] : "";

  const resultado = [];
  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    const [codigo, nombre, pin, activo, cargo] = fila;
    if (codigo && activo === true) {
      const salarioMensual = colSalario > -1 ? Number(fila[colSalario]) || 0 : 0;
      const tipoPersonal = colTipoPersonal > -1 && String(fila[colTipoPersonal]).toUpperCase().trim() === "TURNO" ? "TURNO" : "PLANTA";
      resultado.push({
        codigo: codigo, nombre: nombre, cargo: cargo,
        salarioMensual: salarioMensual, tipoPersonal: tipoPersonal,
        fechaIngreso: colIngreso > -1 ? fila[colIngreso] : null,
        auxilioTransporte: (salarioMensual > 0 && salarioMensual <= TOPE_SALARIOS_AUXILIO_TRANSPORTE) ? AUXILIO_TRANSPORTE_2026 : 0,
        esConfianza: colConfianza > -1 && fila[colConfianza] === true,
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
  if (salidaAlmMin !== undefined) {
    // Si marcó que salió a almorzar pero nunca marcó el regreso (fue directo
    // a Salida), se asume que el almuerzo real fue de 0 minutos marcados —
    // igual se estira al mínimo acordado más abajo. Así el "hueco" del
    // almuerzo queda en el momento correcto (cuando realmente salió), no
    // recortado al final de la jornada.
    const regresoReal = regresoAlmMin !== undefined ? regresoAlmMin : salidaAlmMin;
    const almuerzoReal = regresoReal - salidaAlmMin;
    // Si el almuerzo real fue más corto que el mínimo acordado, se "estira"
    // el regreso efectivo para que el descuento total sea siempre el mínimo.
    const regresoEfectivo = almuerzoReal < MINUTOS_MINIMOS_ALMUERZO
      ? salidaAlmMin + MINUTOS_MINIMOS_ALMUERZO
      : regresoReal;
    if (regresoEfectivo >= salidaMin) {
      return [[entradaMin, salidaAlmMin]]; // el almuerzo mínimo ya cubre el resto del día
    }
    return [[entradaMin, salidaAlmMin], [regresoEfectivo, salidaMin]];
  }
  // Nunca marcó ni salida ni entrada de almuerzo (ej. fue directo de Entrada
  // a Salida) — igual se descuenta el mínimo de almuerzo acordado, porque
  // es imposible que haya trabajado corrido sin parar a comer ese tiempo.
  const salidaConDescuento = Math.max(entradaMin, salidaMin - MINUTOS_MINIMOS_ALMUERZO);
  return [[entradaMin, salidaConDescuento]];
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
  const zona = ZONA_HORARIA_MONTANA;
  const primerDiaMes = new Date(mesTexto + "-01T00:00:00");
  const ultimoDiaMes = new Date(primerDiaMes.getFullYear(), primerDiaMes.getMonth() + 1, 0);
  const diasDelMes = ultimoDiaMes.getDate();

  const detalle = empleados
    .filter(emp => emp.tipoPersonal !== "TURNO") // los turneros no provisionan — se les paga el día, sin prestaciones acumulables
    .map(emp => {
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
