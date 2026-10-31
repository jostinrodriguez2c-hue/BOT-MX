# Wilcox Company

Sitio estático con funciones de Vercel y catálogo/inventario en Supabase. Las compras están configuradas como demostración: no solicitan tarjeta ni cobran dinero, pero sí descuentan existencias e incrementan el contador de ventas simuladas.

## Requisitos

- Node.js 20 o posterior y una cuenta gratuita de Vercel.
- Un proyecto Supabase.

## Configurar Supabase

1. Crea un proyecto y abre **SQL Editor**.
2. Ejecuta el contenido completo y actualizado de `supabase/schema.sql` cada vez que se agreguen o cambien tablas o funciones.
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
4. Tras modificar `supabase/schema.sql`, vuelve a ejecutar el archivo actualizado en Supabase SQL Editor para crear o actualizar las tablas y funciones, incluidas las lecturas de notificaciones.

## Uso y límites

- En el sitio publicado, el inventario, cantidades, precios, categorías y ventas se consultan/actualizan en Supabase. Los cambios hechos en el HTML en modo `file://` se guardan en el navegador.
- Cualquier persona puede consultar el directorio, los productos y realizar compras simuladas sin iniciar sesión. Solo las funciones de administración del inventario y del sitio requieren una cuenta aprobada.
- La sección original de personas, sus accesos y sus registros continúan guardándose en el navegador; este backend sincroniza el inventario y las compras simuladas. Los datos publicados en el directorio son visibles para cualquiera.
- El formulario ofrece una lista de países y un catálogo de ciudades/sedes que el administrador puede ampliar. No existe una lista práctica y completa de todas las ciudades del mundo; agrega las sedes que use tu organización.
- Al confirmar una compra simulada, el servidor valida y descuenta existencias e incrementa las ventas de demostración de forma atómica. Tiene un límite por dirección de red. No se piden datos de tarjeta, correo ni código de verificación, y no se realiza un cobro.
- Los endpoints anteriores de pago por Mercado Pago/código de correo no forman parte del flujo actual de demostración; no agregues credenciales de pago si solo necesitas simular compras.
- Administradores y trabajadores usan el mismo botón **Trabajador** para iniciar sesión. El servidor asigna el rol; **Administrar todo** y **Ver solicitudes** solo aparecen si la sesión pertenece al correo configurado en `ADMIN_EMAIL` y a `admin_users`. Si una cuenta no ha sido aprobada, el formulario de acceso muestra el error y no inicia sesión. No se habilita un acceso local con contraseña compartida; usa `vercel dev` o el sitio publicado para autenticarte. Los archivos HTML anteriores redirigen a la página actual.
- Para solicitar acceso, la persona escribe su nombre y correo desde **Trabajador**. El administrador revisa la solicitud en **Ver solicitudes**. Después de aprobarla, la persona crea su propia cuenta y contraseña; si Supabase pide confirmar el correo, debe hacerlo antes de iniciar sesión. Las contraseñas nunca se guardan en las tablas de la aplicación ni se muestran al administrador.
- En **Administrar todo → Trabajadores aprobados**, el administrador puede registrar advertencias con motivo y despedir a un trabajador. Despedir cambia el estado de la solicitud a `terminated`, bloquea el inicio de sesión y retira el acceso a las funciones de inventario.
- La campana muestra solo avisos dirigidos a la cuenta actual; las compras simuladas se guardan como notificaciones personales en el navegador que hizo la compra y las advertencias solo aparecen al trabajador correspondiente. El contador usa el número real de avisos no leídos y se reinicia al abrirlos. **Administrar todo → Historial de actividad** conserva el historial completo solo para administradores autorizados; los inicios de sesión aparecen en verde y los cierres en rojo. Las fechas y horas del historial se muestran con la zona horaria de Panamá.
- Las cuentas de trabajador aprobadas pueden administrar productos, categorías y ventas del inventario, pero no pueden administrar perfiles, solicitudes ni la configuración general.
- Para aceptar pagos reales se necesitaría implementar y probar un flujo de pago habilitado por el dueño; esta simulación no demuestra ni procesa pagos reales.
