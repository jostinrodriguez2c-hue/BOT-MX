# Wilcox Company

Sitio estático con funciones de Vercel, catálogo/inventario en Supabase y pago alojado por Mercado Pago. Los datos de tarjeta se introducen únicamente en la página segura de Mercado Pago; este sitio no recibe ni guarda números de tarjeta.

## Requisitos

- Node.js 20 o posterior y una cuenta gratuita de Vercel.
- Un proyecto Supabase.
- Una cuenta de Mercado Pago habilitada para Checkout Pro y cobros en USD en el país de la cuenta.
- Una cuenta Resend y un dominio verificado para enviar códigos de compra.

Los proveedores pueden cobrar comisiones por transacción y sus planes gratuitos tienen límites. La disponibilidad de USD depende de la cuenta y el país de Mercado Pago; verifica esto antes de anunciar ventas.

## Configurar Supabase

1. Crea un proyecto y abre **SQL Editor**.
2. Ejecuta el contenido de `supabase/schema.sql`.
3. En **Authentication**, crea una cuenta de usuario para la persona administradora.
4. En SQL Editor, registra ese usuario como administrador:

   ```sql
   insert into public.admin_users (user_id)
   select id from auth.users where email = 'admin@tu-dominio.com';
   ```

5. Crea categorías en la tabla `product_categories` y productos en `products`. `price_cents` son centavos de USD (por ejemplo, `1250` = `$12.50`). `stock` es el inventario total. No compartas la clave `service_role`.

## Configurar el proyecto local

1. Copia `.env.example` a `.env.local` y completa los valores desde los paneles de cada proveedor. No subas `.env.local` al repositorio.
2. `APP_URL` debe ser el origen público exacto, sin barra final. Para este proyecto usa `https://wilcoxcompany.vercel.app`.
3. `OTP_SECRET` debe ser una cadena aleatoria secreta de al menos 32 bytes. Puedes generarla con:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

4. En Resend, verifica el dominio y configura `RESEND_FROM` con un remitente de ese dominio.
5. Instala Vercel CLI si hace falta (`npm i -g vercel`) y ejecuta `vercel dev` para probar funciones y página en local.
6. Ejecuta `npm run check` para comprobar sintaxis de las funciones.

## Desplegar gratis en Vercel

1. Sube esta carpeta a un repositorio privado tuyo o impórtala desde Vercel.
2. En **Project Settings → Environment Variables**, agrega todas las variables de `.env.example` para Preview y Production. Nunca pongas claves secretas en `index.html`, ni las envíes por chat.
3. Despliega el proyecto y establece `APP_URL` al dominio final; vuelve a desplegar si cambiaste variables.
4. En Mercado Pago, configura la notificación de pagos para `https://TU-DOMINIO/api/payment-webhook` y copia su secreto de firma a `MERCADOPAGO_WEBHOOK_SECRET`.
5. Prueba primero con credenciales de prueba de Mercado Pago. Confirma la recepción del código, un pago aprobado y que el inventario cambie una sola vez. Luego configura credenciales de producción y repite una compra de bajo importe.

## Uso y límites

- En el sitio publicado, el catálogo público, cantidades, precios, categorías y ventas de inventario se consultan/actualizan en Supabase. Los cambios hechos en el HTML en modo `file://` siguen siendo una demostración local, no inventario del sitio publicado.
- La sección original de personas, sus accesos y sus registros continúan guardándose en el navegador; este backend sincroniza solamente el inventario y los pagos.
- Las compras requieren un código de seis dígitos enviado por correo; vence a los 10 minutos, es de un solo uso, limita intentos y solicitudes, y reserva existencias al validarlo.
- El pago usa la página alojada de Mercado Pago. El servidor solo marca la venta después de validar la firma del webhook, el estado aprobado, la moneda USD y el total.
- Las compras pagadas después de vencer su reserva quedan como `paid_review`; revisa esos casos manualmente en Supabase antes de confirmar o reembolsar el pago.
- La administración publicada usa usuarios de Supabase Auth incluidos en `admin_users`; la clave local de demostración no concede permisos al servidor.
- Para comprobar el estado de una compra tras volver del proveedor, la página usa un identificador de orden no secreto. No se exponen correos, direcciones ni datos de tarjeta.
- Este repositorio no puede desplegarse ni cobrar hasta que el dueño cree y configure sus propias cuentas, dominio, productos y secretos. No se han publicado credenciales ni se ha afirmado que el sitio esté en línea.
