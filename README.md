# Wilcox Company

Sitio estático con funciones de Vercel y catálogo/inventario en Supabase. Las compras están configuradas como demostración: no solicitan tarjeta ni cobran dinero, pero sí descuentan existencias e incrementan el contador de ventas simuladas.

## Requisitos

- Node.js 20 o posterior y una cuenta gratuita de Vercel.
- Un proyecto Supabase.

## Configurar Supabase

1. Crea un proyecto y abre **SQL Editor**.
2. Ejecuta el contenido de `supabase/schema.sql`.
3. En **Authentication**, crea una cuenta de usuario para `jostin.rodriguez2c@gmail.com` con una contraseña fuerte que solo tú conozcas. No uses `3`: es demasiado débil y ya fue compartida en el chat. Si ya configuraste esa contraseña en Supabase, cámbiala antes de publicar.
4. Agrega `ADMIN_EMAIL=jostin.rodriguez2c@gmail.com` a las variables de entorno de Vercel. El servidor permite iniciar sesión solo a ese correo y también exige que la cuenta esté en `admin_users`.
5. En SQL Editor, registra ese usuario como administrador:

   ```sql
   insert into public.admin_users (user_id)
   select id from auth.users where email = 'jostin.rodriguez2c@gmail.com';
   ```

6. Crea categorías en la tabla `product_categories` y productos en `products`. `price_cents` son centavos de USD (por ejemplo, `1250` = `$12.50`). `stock` es el inventario total. No compartas la clave `service_role`.

## Configurar el proyecto local

1. Copia `.env.example` a `.env.local` y completa las cuatro variables de Supabase y del administrador. No subas `.env.local` al repositorio ni compartas `SUPABASE_SERVICE_ROLE_KEY`.
2. Instala Vercel CLI si hace falta (`npm i -g vercel`) y ejecuta `vercel dev` para probar funciones y página en local.
3. Ejecuta `npm run check` para comprobar sintaxis de las funciones.

## Desplegar gratis en Vercel

1. Sube esta carpeta a un repositorio privado tuyo o impórtala desde Vercel.
2. En **Project Settings → Environment Variables**, agrega las cuatro variables de `.env.example` para Production (y Preview si la usarás). Nunca pongas claves secretas en `index.html` ni las envíes por chat.
3. Despliega el proyecto.
4. Tras modificar `supabase/schema.sql`, vuelve a ejecutar el archivo actualizado en Supabase SQL Editor para crear o actualizar la función de compra de demostración.

## Uso y límites

- En el sitio publicado, el catálogo público, cantidades, precios, categorías y ventas de inventario se consultan/actualizan en Supabase. Los cambios hechos en el HTML en modo `file://` se guardan en el navegador.
- La sección original de personas, sus accesos y sus registros continúan guardándose en el navegador; este backend sincroniza el inventario y las compras simuladas.
- Al confirmar una compra simulada, el servidor valida y descuenta existencias e incrementa las ventas de demostración de forma atómica. Tiene un límite por dirección de red. No se piden datos de tarjeta, correo ni código de verificación, y no se realiza un cobro.
- Los endpoints anteriores de pago por Mercado Pago/código de correo no forman parte del flujo actual de demostración; no agregues credenciales de pago si solo necesitas simular compras.
- La administración publicada usa usuarios de Supabase Auth incluidos en `admin_users`; la clave local de demostración no concede permisos al servidor.
- Para aceptar pagos reales se necesitaría implementar y probar un flujo de pago habilitado por el dueño; esta simulación no demuestra ni procesa pagos reales.
