# BunkrScr

Extractor y descargador de albumes para plataformas de almacenamiento de archivos. Aplicacion CLI con soporte para descarga directa HTTP e integracion con IDM (Internet Download Manager).

## Caracteristicas

- Extraccion de archivos desde albumes paginados
- Descarga concurrente con barras de progreso individuales
- Soporte para IDM (cola de descargas externa)
- Historial de descargas para evitar duplicados
- Filtro por tipo de archivo (video / comprimido / personalizado)
- Configuracion persistente de ruta y preferencias
- Interfaz shell interactiva

## Requisitos

- Python 3.11+
- Dependencias: `httpx`, `beautifulsoup4`, `rich`, `questionary`

## Instalacion

```bash
git clone https://github.com/latinokodi/bunkr-scraper-pro.git
cd bunkr-scraper-pro
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
start.bat
```

## Uso

```
┌──( bunkr@parser ) [direct] at ~/Downloads
└─ > 
```

Comandos disponibles en la shell:

| Comando | Accion |
|---------|--------|
| `/mode` | Alternar entre Directa e IDM |
| `/slots` | Cambiar descargas simultaneas (1-5) |
| `/types` | Filtrar por tipo de archivo |
| `/path` | Cambiar carpeta de descarga |
| `/clear` | Borrar historial |
| `/status` | Mostrar configuracion actual |
| `/help` | Referencia de comandos |
| `<URL>`  | Pegar enlace de album |

## Estructura

```
bunkr-scraper-pro/
├── src/
│   ├── main_cli.py          # Shell interactiva
│   ├── config.py            # Constantes y tema UI
│   ├── core/
│   │   └── extractor.py     # Extraccion y resolucion de enlaces
│   └── utils/
│       ├── downloader.py    # Descarga HTTP concurrente
│       ├── idm.py           # Integracion con IDM
│       ├── history.py       # Historial de descargas
│       └── settings.py      # Configuracion persistente
├── requirements.txt
└── start.bat
```

## Aviso legal

**Este software se proporciona exclusivamente con fines educativos y de investigacion.**

El autor no se hace responsable del uso que terceros puedan dar a esta herramienta. No esta destinado a la descarga de material protegido por derechos de autor sin la debida autorizacion. El usuario es el unico responsable de cumplir con las leyes aplicables en su jurisdiccion, incluyendo pero no limitado a leyes de propiedad intelectual y derechos de autor.

Esta herramienta no aloja, almacena ni distribuye ningun tipo de contenido. Funciona unicamente como un cliente HTTP que automatiza solicitudes web, de manera similar a un navegador convencional.

El uso de este software implica la aceptacion de estos terminos.
