# Configuración de Supabase y Atajos iOS

Esta versión mantiene el funcionamiento local de la aplicación y añade:

- acceso mediante código enviado por correo;
- sincronización entre dispositivos;
- actualización en tiempo real;
- importación inicial de los datos que ya existan en el dispositivo;
- recepción de pagos desde Atajos sin abrir Safari;
- protección mediante Row Level Security;
- detección de pagos duplicados.

El Código de Bóveda continúa siendo local en cada dispositivo. Supabase se utiliza para identificar la cuenta y sincronizar los datos financieros.

## 1. Crear el proyecto de Supabase

1. Entra en <https://supabase.com/dashboard>.
2. Pulsa **New project**.
3. Elige una contraseña fuerte para la base de datos y guárdala fuera de GitHub.
4. Selecciona una región europea cercana.
5. Espera a que el proyecto termine de crearse.

## 2. Crear las tablas y reglas de seguridad

1. En Supabase, abre **SQL Editor**.
2. Pulsa **New query**.
3. Abre el archivo `supabase-setup.sql` incluido en este paquete.
4. Copia todo su contenido en el editor.
5. Pulsa **Run**.
6. Comprueba que aparezca el mensaje de ejecución correcta.

El script crea las tablas, activa Row Level Security y añade las funciones necesarias para la sincronización y el atajo.

## 3. Configurar el correo con código OTP

La aplicación utiliza un código escrito dentro de la propia PWA. Esto evita que el enlace del correo abra Safari y cree una sesión separada.

1. En Google activa la verificación en dos pasos y crea una **Contraseña de aplicación** llamada `Supabase SMTP`.
2. Abre **Supabase → Authentication → Emails → SMTP Settings**.
3. Activa SMTP personalizado y utiliza:

   - Sender email: tu dirección completa de Gmail.
   - Sender name: `Control de Finanzas`.
   - Host: `smtp.gmail.com`.
   - Port: `465`.
   - Username: tu dirección completa de Gmail.
   - Password: la contraseña de aplicación de 16 caracteres generada por Google.

4. Guarda y abre **Authentication → Emails → Templates → Magic link or OTP**.
5. Utiliza como asunto `Tu código de acceso a Control de Finanzas` y sustituye el enlace por un mensaje que incluya esta variable:

   ```text
   Tu código para Control de Finanzas es: {{ .Token }}
   ```

6. Guarda la plantilla.
7. En **Authentication → URL Configuration**, establece **Site URL** con la dirección publicada de GitHub Pages, por ejemplo:

   ```text
   https://USUARIO.github.io/REPOSITORIO/
   ```

## 4. Obtener la URL y la clave pública

1. En Supabase, abre el botón **Connect** o **Project Settings → API Keys**.
2. Copia:
   - **Project URL**: termina en `.supabase.co`.
   - **Publishable key**: empieza por `sb_publishable_`.
3. Abre `supabase-config.js` y reemplaza los dos textos de ejemplo:

   ```javascript
   window.FINANCE_SUPABASE_CONFIG = Object.freeze({
     url: 'https://gyirfajfrvayugwxrgyw.supabase.co',
     publishableKey: 'sb_publishable_o-JbBNO6M5knOKnG_0Eu-A_IqFPdITt'
   });
   ```

La clave pública puede estar en GitHub porque solamente obtiene los permisos concedidos por RLS. No utilices nunca una clave `sb_secret_`, `service_role` o una clave privada en estos archivos.

## 5. Subir los archivos a GitHub

Sube a la raíz del repositorio y reemplaza las versiones anteriores:

- `index.html`
- `manifest.json`
- `sw.js`
- `cloud-sync.js`
- `supabase-config.js`
- `favicon-32.png`
- `apple-touch-icon.png`
- `icon-192.png`
- `icon-512.png`
- `icon-maskable-512.png`
- `.nojekyll`

Conserva también `supabase-setup.sql` fuera de la web pública si lo deseas; no contiene claves, pero no es necesario para ejecutar la aplicación.

Espera a que GitHub Pages termine el despliegue. Después cierra completamente la web app en iOS y ábrela de nuevo. Si siguiera apareciendo una versión antigua, elimina el icono de la pantalla de inicio, abre la dirección en Safari y vuelve a elegir **Añadir a pantalla de inicio → Abrir como app web**.

## 6. Iniciar sesión y migrar los datos existentes

1. Abre la web app desde su icono de iOS.
2. Abre el panel lateral.
3. Pulsa **Sincronización Supabase**.
4. Introduce tu correo.
5. Pulsa **Enviar código de acceso**.
6. Copia el código recibido por correo y escríbelo dentro de la web app.
7. Pulsa **Verificar y sincronizar**.

En el primer dispositivo, la aplicación subirá automáticamente los datos locales existentes. En un dispositivo nuevo, descargará los datos que ya estén en Supabase.

## 7. Crear la clave segura para el atajo

1. Dentro de **Sincronización Supabase**, pulsa **Crear o renovar clave del atajo iOS**.
2. Pulsa **Copiar clave**.
3. Guarda temporalmente la clave para configurar Atajos.

Supabase guarda únicamente el hash de la clave. La clave completa solo se muestra una vez. Si se pierde o se filtra, genera otra; la anterior dejará de funcionar.

## 8. Configurar la automatización de pagos en Atajos

1. Abre **Atajos → Automatización**.
2. Crea una automatización personal de tipo **Transacción**.
3. Selecciona las tarjetas deseadas.
4. Elige **Ejecutar inmediatamente** y desactiva cualquier confirmación previa disponible.
5. Elimina la acción **Abrir URL**. Esa acción es la que falla con el teléfono bloqueado y abre Safari con un almacenamiento diferente.
6. Añade una acción para obtener los detalles de la transacción y utiliza las variables que iOS muestre para:
   - importe;
   - comercio o establecimiento;
   - fecha de la transacción.
7. Añade la acción **Obtener contenido de URL**.

Configúrala así:

### URL

```text
https://gyirfajfrvayugwxrgyw.supabase.co/rest/v1/rpc/ingest_wallet_payment
```

### Método

```text
POST
```

### Cabeceras

```text
apikey       sb_publishable_o-JbBNO6M5knOKnG_0Eu-A_IqFPdITt
Content-Type application/json
```

### Cuerpo de la solicitud

Selecciona **JSON** y crea estos campos:

| Campo | Valor |
|---|---|
| `p_token` | La clave `fin_...` generada por la web app |
| `p_amount` | Variable Importe de la transacción |
| `p_concept` | Variable Comercio o Establecimiento |
| `p_external_id` | Texto único formado con fecha, importe y comercio |
| `p_occurred_at` | Variable Fecha en formato ISO 8601 |

Para `p_external_id` puedes añadir primero una acción **Texto** con un contenido semejante a:

```text
[Fecha]-[Importe]-[Comercio]
```

Utiliza las variables mágicas de Atajos en lugar del texto entre corchetes. Este identificador impide registrar dos veces el mismo pago si la automatización se repite.

8. Opcionalmente, añade **Mostrar notificación** con el texto “Pago enviado a Control de Finanzas”.
9. Guarda la automatización.

La automatización ya no necesita abrir Safari ni la web app. Envía el pago a Supabase y la PWA lo recibe al instante si está abierta o durante la siguiente sincronización.

## 9. Probar el funcionamiento

Realiza primero una prueba con el teléfono desbloqueado:

1. Ejecuta la automatización manualmente con un importe de prueba o realiza una transacción pequeña.
2. Comprueba que **Obtener contenido de URL** devuelva un objeto con `"ok": true`.
3. Abre la web app y pulsa **Sincronizar ahora** si el movimiento no aparece inmediatamente.
4. Comprueba en Supabase **Table Editor → wallet_ingest_events** que exista el evento.
5. Repite después la prueba con el teléfono bloqueado.

Si el mismo pago se intenta enviar otra vez, la respuesta incluirá `"duplicate": true` y no se añadirá otro movimiento.

## 10. Consultas de comprobación

En **SQL Editor** puedes ejecutar:

```sql
select user_id, revision, updated_at
from public.finance_snapshots
order by updated_at desc;

select external_id, amount, concept, occurred_at, created_at
from public.wallet_ingest_events
order by created_at desc
limit 20;
```

## Resolución de problemas

- **No llega el correo:** revisa Authentication → Logs y la carpeta de correo no deseado.
- **Llega un enlace en vez de un código:** la plantilla todavía usa `{{ .ConfirmationURL }}`; cámbiala por `{{ .Token }}`.
- **Error 401 en Atajos:** revisa `apikey` y la clave `p_token`. No añadas la clave del atajo a la URL.
- **Error de función inexistente:** vuelve a ejecutar `supabase-setup.sql` completo.
- **La aplicación dice “Pendiente de configurar”:** revisa `supabase-config.js` y confirma que se haya subido a GitHub.
- **Los cambios tardan en aparecer:** pulsa **Sincronizar ahora** y verifica que Realtime esté habilitado para `finance_snapshots`.
- **La automatización abre Safari:** todavía contiene la acción **Abrir URL**; elimínala.
