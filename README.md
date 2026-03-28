# Bunkr Scraper PRO 🚀

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](https://polyformproject.org/licenses/noncommercial/1.0.0/)
[![Electron](https://img.shields.io/badge/Framework-Electron-blueviolet)](https://www.electronjs.org/)
[![Python](https://img.shields.io/badge/Language-Python%203.12-yellow)](https://www.python.org/)

**Bunkr Scraper PRO** es una herramienta de escritorio potente y elegante diseñada para descargar contenido multimedia de álbumes de Bunkr de forma automatizada. Combina la velocidad de un motor de scraping en Python con una interfaz moderna y futurista construida en Electron.

Copyright (c) 2026 **latinokodi**

![Demo Screenshot](https://via.placeholder.com/1200x675/0a0a0c/00f2fe?text=Bunkr+Scraper+PRO+Dashboard)

## ✨ Características Principales

- 🎨 **Dashboard Premium**: Interfaz futurista con estética "Neon Cyberpunk", modo oscuro y animaciones fluidas.
- ⚡ **Desencriptación XOR**: Implementa el protocolo de extracción de 4 pasos (Album → File Detail → API POST → XOR Decryption → CDN Stream).
- 📂 **Selección de Carpeta Personalizada**: Elige exactamente dónde quieres guardar tus archivos con un explorador de carpetas nativo.
- 🔄 **Modo Avanzado Automático**: Soporte para álbumes grandes (>100 archivos) mediante el modo `?advanced=1` y crawling de paginación automática.
- ⏹️ **Control Total**: Botón de **STOP** para abortar descargas en curso de forma segura.
- 💾 **Persistencia**: Recuerda tu última ruta de descarga seleccionada para la próxima sesión.
- 🛠️ **Robusto**: Manejo de errores para servidores en mantenimiento o archivos caídos.

## 🚀 Instalación y Configuración

### 📋 Requisitos Previos
1. **Python 3.12+** (Asegúrate de marcar "Add to PATH" durante la instalación).
2. **Node.js 24+** (Para ejecutar la interfaz de Electron).
3. **Git** (Opcional, para clonar el repositorio).

### 🛠️ Configuración Automática
Simplemente ejecute el archivo lanzador incluido:

```bash
start.bat
```

Este script se encargará de:
- Crear el entorno virtual de Python (`.venv`).
- Instalar todas las dependencias de Python (`requests`, `beautifulsoup4`, etc.).
- Instalar las dependencias de Electron (`npm install`).
- Iniciar la aplicación automáticamente.

## 📖 Cómo Usar

1. Inicia la aplicación usando `start.bat`.
2. (Opcional) Haz clic en **EXAMINAR** (BROWSE) para seleccionar tu carpeta de destino.
3. Pega el enlace del álbum de Bunkr (ej: `https://bunkr.cr/a/...`).
4. Haz clic en **INICIAR DESCARGA**.
5. Observa el progreso en tiempo real en el Dashboard.

## 🛠️ Arquitectura Técnica

- **Frontend**: HTML5, CSS3 (Vanilla + Glassmorphism), JavaScript (ES6).
- **Runtime**: Electron.js (con IPC bridge seguro mediante `preload.js`).
- **Backend (Engine)**: Python 3.12 utilizando la librería `requests` para flujos de datos de alta velocidad y `BeautifulSoup` para parsing de HTML.
- **Seguridad**: Comunicación aislada entre procesos mediante `contextBridge`.

## 📄 Licencia

Este proyecto está bajo la Licencia MIT. Consulta el archivo `LICENSE` para más detalles.

---

**Nota**: Esta herramienta es solo para fines educativos y de respaldo personal. Por favor, respeta los términos de servicio de las plataformas externas.
