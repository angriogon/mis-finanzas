# Control de Finanzas — entrega para GitHub Pages

Esta carpeta contiene la web app completa, la sincronización con Supabase, el modo instalable de iOS y la recepción de pagos desde Atajos sin abrir Safari.

## Configuración incorporada

La carpeta ya contiene la URL y la clave pública del proyecto:

```javascript
window.FINANCE_SUPABASE_CONFIG = Object.freeze({
  url: 'https://gyirfajfrvayugwxrgyw.supabase.co',
  publishableKey: 'sb_publishable_o-JbBNO6M5knOKnG_0Eu-A_IqFPdITt'
});
```

No introduzcas nunca una clave `service_role`, `sb_secret_`, la contraseña de la base de datos, la contraseña de Gmail ni la contraseña SMTP.

## Preparar Supabase

1. Abre **SQL Editor** en Supabase.
2. Copia y ejecuta una vez todo el contenido de `supabase-setup.sql`.
3. Comprueba que el SMTP de Gmail esté guardado.
4. En **Authentication → Emails → Templates → Magic link or OTP**, utiliza `{{ .Token }}`.
5. En **Authentication → URL Configuration**, establece como Site URL la dirección de GitHub Pages.

## Publicar

Sube el contenido de esta carpeta a la raíz del repositorio. `index.html` debe quedar en la raíz, no dentro de otra carpeta. Activa GitHub Pages para la rama y carpeta donde estén los archivos.

Cuando GitHub termine de publicar:

1. Abre la dirección HTTPS en Safari del iPhone.
2. Pulsa **Compartir → Añadir a pantalla de inicio → Abrir como app web**.
3. Abre la aplicación instalada.
4. Pulsa **Inicio → menú ☰ → Sincronización Supabase**.
5. Solicita el código, introdúcelo y sincroniza.
6. Crea la clave del Atajo iOS y pulsa **Copiar datos completos del atajo**.

La automatización debe usar **Obtener contenido de URL** con método `POST`. Elimina cualquier acción **Abrir URL**, porque esa acción intenta iniciar Safari y provoca el error con el teléfono bloqueado.

Consulta `GUIA-SUPABASE-IOS.md` para el cuerpo JSON y la configuración completa del Atajo.
