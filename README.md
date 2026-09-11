# FeriaUva

Aplicación web estática para administrar vendedores, productos y ventas del Festival de la Uva. La interfaz usa HTML, CSS y JavaScript sin proceso de compilación; los datos se almacenan en Supabase.

## Estructura

```text
.
├── public/                 # Todo lo que Netlify sirve
│   ├── index.html          # Inicio de sesión y registro
│   ├── admin.html          # Panel de administración
│   ├── vendedor.html       # Panel del vendedor
│   ├── *.js                # Lógica de cada pantalla y núcleo compartido
│   ├── *.css               # Estilos compartidos y específicos
│   └── imagen/logo.jpg     # Identidad visual
├── database/               # Scripts SQL para preparar Supabase
└── netlify.toml            # Configuración de publicación en Netlify
```

## Publicar en GitHub

Desde esta carpeta:

```powershell
git init
git add .
git commit -m "Preparar FeriaUva para publicación"
git branch -M main
git remote add origin https://github.com/aglprogamer-byte/FeriaUva.git
git push -u origin main
```

Si ya existe un remoto llamado `origin`, actualízalo con `git remote set-url origin https://github.com/aglprogamer-byte/FeriaUva.git`.

## Conectar GitHub con Netlify

1. En Netlify, selecciona **Add new site** y después **Import an existing project**.
2. Elige GitHub y autoriza el repositorio `aglprogamer-byte/FeriaUva`.
3. Usa estos valores de configuración:
   - **Build command:** vacío
   - **Publish directory:** `public`
4. Selecciona **Deploy site**.

Cada `git push` a `main` generará un nuevo despliegue automáticamente.

## Preparar Supabase

1. Abre el SQL Editor de Supabase.
2. Ejecuta [`database/supabase-rls-fix.sql`](database/supabase-rls-fix.sql) para crear o actualizar las políticas y funciones usadas por la aplicación.
3. Usa [`database/eliminar-vendedor-prueba.sql`](database/eliminar-vendedor-prueba.sql) solo si necesitas eliminar el usuario de prueba.

La aplicación usa la URL y la clave pública `anon` de Supabase desde `public/app-core.js`. Esa clave puede aparecer en el navegador; la protección debe hacerse mediante RLS, políticas y funciones SQL. Nunca subas una `service_role` key, contraseñas ni archivos `.env` al repositorio.

## Ejecutar localmente

Puedes abrir `public/index.html` directamente para revisar la interfaz. Para probarlo con un servidor local, usa cualquier servidor estático, por ejemplo:

```powershell
npx serve public
```

Luego abre la URL que indique el comando.
