# POCOCAR – Gestor de turnos con base de datos compartida

Antes, cada móvil guardaba los datos en su propio navegador (`localStorage`), por eso
al entrar desde otro dispositivo no aparecía nada. Ahora la app tiene un **servidor con
base de datos SQLite integrada**: todos los dispositivos leen y escriben los mismos datos.

## Qué se guarda en la base de datos
- Usuarios y contadores de viajes (altas y bajas)
- Disponibilidad de cada trabajador y "No voy esta semana"
- Cuadrante actual y fecha de la semana
- Historial de cuadrantes
- PIN del equipo y clave de administrador (solo el admin puede verlos o cambiarlos)

Todo está en **un único fichero**: `data/pococar.db`.

## Ponerlo en marcha (en tu ordenador)
Necesitas Node.js 18 o superior (https://nodejs.org).

```
npm install
npm start
```
Abre http://localhost:3000. Para probar desde otros móviles de tu Wi-Fi, usa
`http://IP-DE-TU-PC:3000`.

La primera vez que arranca, la base de datos se crea con los 13 usuarios y los
contadores de la hoja "Contador" de Turnos.xlsx (Susi 10, Javi 12, Montero 12…).
Si alguno no es correcto, cámbialo en `DEFAULT_COUNTERS` (al principio de `server.js`)
ANTES del primer arranque, o borra `data/pococar.db` y vuelve a arrancar.

## Publicarlo en internet (para que funcione desde cualquier sitio)
Necesitas un alojamiento que ejecute Node.js y tenga **disco persistente** (volumen).
Sin disco persistente, el fichero de la base de datos se borra cada vez que el servicio
se reinicia o se vuelve a desplegar.

Configuración típica:
- Comando de arranque: `npm start`
- Variable `DATA_DIR` = ruta del volumen persistente (por ejemplo `/data`)
- Variable `PORT`: la suele poner el propio alojamiento
- Opcionales, solo para el primer arranque: `TEAM_PIN` y `ADMIN_KEY`

Usa siempre HTTPS (los alojamientos lo dan): es necesario para instalar la app en el
iPhone como aplicación y evita que el PIN viaje en claro.

## Seguridad: haz esto el primer día
1. Entra como administrador (PIN `1234`, clave `admin`).
2. Toca "🔐 Cambiar Credenciales" y cambia el PIN del equipo y la clave de admin.

Ahora el PIN se comprueba en el servidor (antes se comprobaba en el navegador y cualquiera
podía verlo). Un trabajador solo puede modificar su propia disponibilidad; solo el admin
puede generar/editar cuadrantes, gestionar usuarios y ver el historial.
Tras 10 intentos fallidos desde la misma IP, el login se bloquea 10 minutos.

## Copias de seguridad
- Botón "💾 Copia de seguridad" en el panel admin: descarga todos los datos en un JSON.
- O copia el fichero `data/pococar.db` (con el servidor parado).

## Instalar en el iPhone
Abre la dirección web en Safari → Compartir → "Añadir a pantalla de inicio".
(Ya no se abre `index.html` como fichero: hay que entrar por la dirección del servidor.)

## Cambios respecto a la versión anterior
- Datos en servidor (SQLite) en lugar de `localStorage`; login validado en el servidor.
- La app se sincroniza sola cada 30 s y al volver a abrirla.
- "Generar turnos" lee la disponibilidad más reciente del servidor antes de calcular, y
  todo lo que guarda (cuadrante, contadores, historial, reinicio de disponibilidad) se
  hace en una sola transacción: o se guarda todo o no se guarda nada.
- Corregido: al editar el cuadrante, los contadores NO se ajustaban (había dos funciones
  `saveTableEdit` y la segunda, que era la que se ejecutaba, leía `conductors` en vez de
  `conductores`).
- Corregido: al aceptar el aviso "faltan disponibilidades" la app daba error
  (`const whatsappMessage` se modificaba después).
- Corregido: tras generar el cuadrante, las casillas de disponibilidad de un trabajador
  con la app abierta no se vaciaban.
- El PIN y la clave ya no se escriben en la consola del navegador.
- Iconos nuevos: el `icon-192.png` original estaba corrupto y `icon-512.png` no existía.
- Al dar de baja a un usuario también se borra su disponibilidad.
