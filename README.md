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
7. En **Authentication → URL Configuration**, configura como **Site URL** el dominio publicado del portal y agrega ese dominio a **Redirect URLs**. En **Authentication → SMTP Settings**, configura un proveedor de correo para que Supabase pueda entregar enlaces de recuperación.

## Configurar el proyecto local

1. Copia `.env.example` a `.env.local` y completa las cuatro variables de Supabase y del administrador. No subas `.env.local` al repositorio ni compartas `SUPABASE_SERVICE_ROLE_KEY`.
2. Instala Vercel CLI si hace falta (`npm i -g vercel`) y ejecuta `vercel dev` para probar funciones y página en local.
3. Ejecuta `npm run check` para comprobar sintaxis de las funciones.

## Desplegar gratis en Vercel

1. Importa esta carpeta en un repositorio privado conectado al proyecto de Vercel. Cada cambio de `index.html`, `api/` o `lib/` debe subirse al repositorio y desplegarse; abrir el archivo con doble clic (`file://`) no publica ni conecta las funciones.
2. En **Project Settings → Environment Variables**, configura para Production `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y `ADMIN_EMAIL`. Si cambias variables, vuelve a desplegar. Nunca pongas claves secretas en `index.html` ni las envíes por chat.
3. En **Authentication → URL Configuration**, configura **Site URL** y **Redirect URLs** con el dominio publicado, por ejemplo `https://wilcoxcompany.vercel.app`.
4. Despliega el proyecto y comprueba que `https://wilcoxcompany.vercel.app/api/products` responda JSON. Si muestra `404`, Vercel está sirviendo una versión sin la carpeta `api/` o el proyecto apunta a otra carpeta/repositorio.
5. Cada vez que cambie `supabase/schema.sql`, ejecútalo completo en Supabase SQL Editor. Esta versión incluye los catálogos compartidos de empresas/cargos/departamentos y roles, la columna `role_id` en las solicitudes y las funciones/tablas del portal.

## Uso y límites

- En el sitio publicado, el inventario, cantidades, precios, categorías y ventas se consultan/actualizan en Supabase. Los cambios hechos en el HTML en modo `file://` se guardan en el navegador.
- Cualquier persona puede consultar los perfiles públicos, los productos y realizar compras simuladas sin iniciar sesión. Las funciones internas requieren iniciar sesión; los permisos de trabajador se verifican tanto en la interfaz como en el servidor.
- La sección original de personas, sus accesos y sus registros continúan guardándose en el navegador; este backend sincroniza el inventario y las compras simuladas. Los datos publicados en el directorio son visibles para cualquiera.
- El formulario ofrece una lista de países y un catálogo de ciudades/sedes que el administrador puede ampliar. No existe una lista práctica y completa de todas las ciudades del mundo; agrega las sedes que use tu organización.
- Al confirmar una compra simulada, el servidor valida y descuenta existencias e incrementa las ventas de demostración de forma atómica. Tiene un límite por dirección de red. No se piden datos de tarjeta, correo ni código de verificación, y no se realiza un cobro.
- Si `/api/demo-purchase` devuelve un error `PGRST202`, actualiza la función `register_demo_purchase` y la tabla `purchase_rate_limits` ejecutando el bloque de compras de demostración de `supabase/schema.sql` en Supabase SQL Editor y recargando el esquema de PostgREST.
- Los endpoints anteriores de pago por Mercado Pago/código de correo no forman parte del flujo actual de demostración; no agregues credenciales de pago si solo necesitas simular compras.
- Administradores y trabajadores usan el mismo botón **Trabajador** para iniciar sesión. El servidor asigna el rol y los permisos; **Administrar todo** y los botones laterales para gestionar catálogos solo aparecen para la cuenta configurada en `ADMIN_EMAIL` y en `admin_users`. El permiso `applications_review` permite revisar solicitudes sin otorgar administración suprema. Si una cuenta no ha sido aprobada, el formulario muestra un error y no inicia sesión. No se habilita un acceso local con contraseña compartida; usa `vercel dev` o el sitio publicado para autenticarte. Los archivos HTML anteriores redirigen a la página actual.
- Al actualizar la página, se restaura la sección y subpestaña abiertas, además de la posición de desplazamiento, dentro de esa pestaña del navegador. La sesión web se guarda solo en `sessionStorage` y el servidor la valida al restaurar; el acceso local de pruebas solo se restaura al abrir el archivo local.
- Para solicitar acceso, la persona escribe su nombre y correo desde **Trabajador**. El administrador revisa la solicitud en **Ver solicitudes**. Después de aprobarla, la persona crea su propia cuenta y contraseña; si Supabase pide confirmar el correo, debe hacerlo antes de iniciar sesión. Las contraseñas nunca se guardan en las tablas de la aplicación ni se muestran al administrador.
- En **Administrar todo → Trabajadores aprobados**, el administrador puede registrar advertencias con motivo y despedir a un trabajador. Despedir cambia el estado de la solicitud a `terminated`, bloquea el inicio de sesión y retira el acceso a las funciones de inventario.
- En **Administrar todo → Personas → Datos laborales de Personas**, el administrador asigna a cada trabajador aprobado su departamento, cargo, empresa y rol. Los datos y catálogos se guardan en Supabase y se comparten entre dispositivos. **Trabajadores aprobados** conserva las acciones de advertencia, despido y restablecimiento de contraseña.
- Los botones laterales **Empresas**, **Cargos**, **Departamentos** y **Roles y permisos** están reservados al administrador supremo. Desde ahí se pueden crear, editar y eliminar catálogos y definir permisos para roles. Al eliminar un departamento, cargo o empresa asignado, se quita también de las personas afectadas para que aparezca vacío y se pueda elegir otra opción en **Personas**. Un rol personalizado puede eliminarse aunque tenga trabajadores asignados: sus cuentas siguen activas, quedan sin rol y aparecen en **Personas** para asignarles uno nuevo. El rol predeterminado **Trabajador** está protegido y no se puede eliminar ni renombrar.
- Desde esas mismas listas, el administrador puede enviar al correo de un trabajador con cuenta un enlace de restablecimiento. La persona abre el enlace, define una contraseña nueva y luego inicia sesión normalmente. Supabase maneja el enlace y la contraseña; el portal nunca los almacena ni los muestra.
- Al entrar como trabajador, **Inventario → Equipo de trabajo** muestra el directorio y las asignaciones laborales; **Ver catálogos** permite consultar los departamentos, cargos y empresas. Cada sección solo aparece para roles que tengan su permiso correspondiente. El directorio no muestra correos ni contraseñas y calcula la antigüedad desde la aprobación.
- La campana muestra solo avisos dirigidos a la cuenta actual; las compras simuladas se guardan como notificaciones personales en el navegador que hizo la compra y las advertencias solo aparecen al trabajador correspondiente. El contador usa el número real de avisos no leídos y se reinicia al abrirlos. **Administrar todo → Historial de actividad** conserva el historial completo solo para administradores autorizados; los inicios de sesión aparecen en verde y los cierres en rojo. Las fechas y horas del historial se muestran con la zona horaria de Panamá.
- El rol predeterminado **Trabajador** permite consultar inventario, registrar ventas, administrar productos y ver el directorio. En **Roles y permisos**, el administrador puede crear otros roles con permisos específicos para inventario, ventas, productos, directorio, solicitudes y consulta de catálogos. Los trabajadores nunca pueden modificar empresas, cargos o departamentos, ni administrar perfiles o la configuración general.
- Para aceptar pagos reales se necesitaría implementar y probar un flujo de pago habilitado por el dueño; esta simulación no demuestra ni procesa pagos reales.
