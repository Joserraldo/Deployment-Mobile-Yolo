# 🚗 Guía de Despliegue — Detector de Placas YOLOv8 (EC2 + Expo Go)

> Estado: **DESPLIEGADO Y PROBADO** — API detectando placas en vivo desde AWS.
> Prueba real: imagen `carroprueba.JPG` → placa detectada **`JNU540`** ✅

---

## 🔑 tus credenciales (recuerda estas 3 cosas)

| Qué | Valor |
|---|---|
| IP del servidor (API) | **`$SERVER_IP`** |
| Puerto | **`8080`** |
| Llave SSH | `llaveplaca.pem` (local, fuera de git) |

> ⚠️ **NUNCA compartas tu `.pem` ni tus credenciales AWS.** Con la IP + la llave ya basta para todo; no necesitas pasar claves de AWS a nadie.

> 📝 Los marcadores `$SERVER_IP` / `$KEYSTORE_PASS` de esta guía tienen sus valores reales en `SECRETS.local.md` y `DetectorPlacas/.env` (ambos fuera de git a propósito).

---

## 🗺️ ¿Cómo funciona todo? (arquitectura)

```
┌─────────────┐   foto (base64)    ┌──────────────────────────┐
│  Tu celular │ ──── HTTP ───────► │  AWS EC2  $SERVER_IP:8080│
│  Expo Go    │ ◄─── JSON + imagen │  FastAPI + YOLOv8 + OCR  │
└─────────────┘   (placa detectada)│  (servicio systemd:      │
      ▲                            │   yolo-plates.service)   │
      │ QR / exp://                └──────────────────────────┘
┌─────────────┐
│  Tu PC      │  npx expo start  →  Metro (paquete JS de la app)
│ (Windows)   │  El celular baja la app desde tu PC, pero las
└─────────────┘  fotos se envían DIRECTO a AWS por internet.
```

1. **EC2 (AWS)** corre un servidor **FastAPI** con tu modelo `best.pt` (YOLOv8) + **EasyOCR**. Escucha en `0.0.0.0:8080`.
2. La **app Expo** (en tu PC, con `npx expo start`) se instala en tu celular vía **Expo Go** (escaneando el QR).
3. En la app escribes **IP `$SERVER_IP`** y **puerto `8080`**, tomas foto, y la app hace `POST http://$SERVER_IP:8080/predict/` con la imagen en base64.
4. El servidor responde JSON con las placas + la imagen marcada + lectura por voz.

**Importante:** el celular NO necesita estar en la misma red que tu PC para hablar con AWS — solo necesita internet (datos sirve ✅). Para que Expo Go cargue la app desde tu PC, sí deben estar en la **misma red Wi-Fi** (o usa un túnel, ver abajo).

---

## 💻 1. Conectarte al servidor (SSH)

**Desde Git Bash / PowerShell en tu PC:**
```bash
ssh -i "llaveplaca.pem" ubuntu@$SERVER_IP
```
- Usuario: **`ubuntu`** (no `root`, no `ec2-user`).
- Si Windows se queja de permisos de la llave (Git Bash): `icacls llaveplaca.pem /inheritance:r /grant:r "$($env:USERNAME):(R)"` (PowerShell) o `chmod 600 llaveplaca.pem` (Git Bash).
- Si la IP cambia al reiniciar la instancia: AWS Console → EC2 → Instances → copia la nueva **Public IPv4**.

**Comandos útiles dentro del servidor:**
```bash
cd /home/ubuntu/proyecto        # carpeta del proyecto
source venv/bin/activate        # activar entorno virtual
sudo systemctl status yolo-plates     # ¿está corriendo la API?
sudo journalctl -u yolo-plates -f     # VER LOGS en vivo (Ctrl+C para salir)
sudo systemctl restart yolo-plates    # reiniciar la API
free -h && df -h /              # RAM y disco
```

## 🌐 2. Probar la API (sin el celular)

Desde cualquier máquina con internet:
```bash
curl http://$SERVER_IP:8080/                        # health check
curl http://$SERVER_IP:8080/docs                    # Swagger (sube fotos desde el navegador 📸)
curl -X POST -F "file=@imagenes/carroprueba.JPG" http://$SERVER_IP:8080/predict/   # prueba real
```
- **`/docs`** es la interfaz interactiva de FastAPI: abre `http://$SERVER_IP:8080/docs` en el navegador, dale *Try it out* a `POST /predict/`, sube una foto de un carro y mira el JSON.

Respuesta esperada:
```json
{"success": true, "placas": ["JNU540"], "num_placas": 1, "image": "<base64...>", "message": "OK"}
```

> 🔄 La demo web anterior (**Veloce Bikes**) sigue viva en `http://$SERVER_IP:8080/web/` — la monté dentro de FastAPI para no perderla.

## 📱 3. La app en tu celular (Expo Go)

### Una sola vez: instala Expo Go
- **Android**: [Play Store → Expo Go](https://play.google.com/store/apps/details?id=host.exp.exponent)
- **iPhone**: [App Store → Expo Go](https://apps.apple.com/app/expo-go/id982107779)

### Cada vez que quieras usarla:
```bash
cd DetectorPlacas
npx expo start -c
```
1. Se abre una terminal con un **código QR**.
2. Abre **Expo Go** en el celular → escanea el QR (Android: botón "Scan"; iPhone: la cámara).
   - El celular y tu PC deben estar en la **misma Wi-Fi**.
   - Si tu red bloquea la conexión (Wi-Fi del colegio/universidad), usa túnel: `npx expo start --tunnel` (instala dependencias la primera vez, pero funciona desde cualquier red).
3. La app **ya trae precargada** la IP `$SERVER_IP` y puerto `8080` (los cambias tocando la píldora **⚙** arriba a la derecha).
4. Apunta a un carro y presiona **◎** → la app muestra la placa (renderizada como placa real) y la deletrea en voz alta 🔊. Puedes activar **"Continuo"** para escaneo automático cada ~2.5 s.

> 💡 Truco para probar sin salir: Imprime o abre en otra pantalla una foto de placa (p. ej. `imagenes/carroprueba.JPG`, placa JNU540) y captúrala con la cámara del celular.

## 🔒 4. Firewall / Security Group (si cambia la IP o el puerto)

Puerto `8080` ya está **abierto** en el Security Group (regla de entrada TCP 8080 desde `0.0.0.0/0`) — por eso la API es visible desde el mundo. **Solo necesitas el 8080** (SSH 22 aparte, solo para tu mantenimiento).

Si necesitas otro puerto en el futuro:
AWS Console → EC2 → Instances → tu instancia → **Security** → *Edit inbound rules* → *Add rule*: Type `Custom TCP`, Port `8080`, Source `0.0.0.0/0` → Save.

## 🛠️ 5. Solución de problemas

| Problema | Causa / Solución |
|---|---|
| `El servidor rechazó la imagen (HTTP 400)` con **fotos de celular** | **Ya corregido** en el server (límite 1 MB → 64 MB, 2026-09-13). Si reaparece en un servidor nuevo: ver parche sección 6. |
| Dice **solo los números** de la placa o una lectura rara | **Corregido 2×** (OCR ahora une las cajas y prueba variantes; sección 6). Si AÚN así lee mal una placa concreta: la foto exacta quedó en `/home/ubuntu/proyecto/debug/` del server — bájala y pruébala en `/docs` para ver qué vio el sistema. |
| `No se pudo contactar el servidor` | Revisa IP `$SERVER_IP` y puerto `8080` en la app (⚙); verifica `curl http://$SERVER_IP:8080/`; en AWS el security group debe tener 8080 abierto. |
| La app Expo Go no carga el QR | PC y celular en la misma Wi-Fi, o usa `npx expo start --tunnel`. |
| Error `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (corporate/UT network) | `set NODE_EXTRA_CA_CERTS=...` o mejor: usa `--tunnel` desde datos del celular. |
| API no responde tras reiniciar instancia | `sudo systemctl restart yolo-plates` (el servicio es `Restart=always` y arranca solo). |
| Servidor sin memoria | `sudo sync && sudo sysctl -w vm.drop_caches=3` (aparece en tu Readme; raro: la instancia es de 8 GB y usa ~1 GB). |
| Cambió la IP pública de EC2 | AWS Console → EC2 → Instances → Public IPv4 (asocia una IP elástica si quieres que no cambie). |
| Quiero subir un `best.pt` nuevo | `scp -i llaveplaca.pem modelo/best.pt ubuntu@$SERVER_IP:/home/ubuntu/proyecto/ && ssh -i llaveplaca.pem ubuntu@$SERVER_IP "sudo systemctl restart yolo-plates"` |

## 📋 6. Lo que quedó montado en el servidor (resumen técnico)

- **`/home/ubuntu/proyecto/`**
  - `app.py` — FastAPI: `POST /predict/` (multipart Y base64), `GET /consulta/{placa}` (expediente demo), `GET /`, `/docs`, demo anterior en `/web/`
  - `best.pt` — tu modelo YOLOv8 entrenado (subido ✅)
  - `venv/` — Python 3.12 + `torch 2.14 CPU`, `ultralytics 8.4`, `easyocr`, `fastapi`, `uvicorn`, `opencv-headless`
  - `app.py.bak-*` — respaldos antes de cada parche (por si hay que revertir)
- **Servicio systemd `yolo-plates`** — arranca solo con el servidor, auto-reinicio si muere, escucha 8080. (El servicio anterior `placa-web` fue deshabilitado en favor de este; la página sigue disponible en `/web/`.)

### 🔧 Parches aplicados 2026-09-13 (server, sin recompilar el APK)
| Fix | Qué arregla |
|---|---|
| **Límite de subida 1 MB → 64 MB** en `POST /predict/` | El 400 que salía al mandar **fotos de celular reales** (varios MB). Starlette limitaba cada campo del form a 1 MB. Respaldo: `app.py.bak-20260913`. |
| **OCR: unir todas las cajas de texto** de la placa + regex de formato colombiano (`AAA123`/`123AAA`) | Antes el OCR a veces leía **solo los números** (descartaba las letras "COLOMBIA" y ruido). Respaldo: `app.py.bak-ocr`. |
| **OCR 2.0 (v1.2.0)**: agranda el recorte (~240px), prueba variantes gris/CLAHE/Otsu con allowlist A-Z0-9, elige la lectura más confiable, deduplica cajas solapadas (`JNU540` vs `JNU54O` → una sola), y limite de 6 OCR/foto | Lee **la placa completa con letras** incluso en fotos medianamente borrosas. Respaldo: `app.py.bak-pre-ocr2`. |
| **Velocidad**: la foto se reduce a 1280px antes de procesar (YOLO trabaja a 640 internamente) + salida temprana del OCR cuando hay confianza | ~2× más rápido: 1.5 s típico (antes 2.8–3.7 s). |
| **Auditoría**: cada foto recibida se guarda en `/home/ubuntu/proyecto/debug/` (solo las 60 últimas) | Si una lectura te parece rara ("dijo FDE650 y no era"), se recupera ESA foto exacta y se reproduce: `scp -i llaveplaca.pem ubuntu@$SERVER_IP:/home/ubuntu/proyecto/debug/* carpeta_local/` y se prueba en `/docs`. |
- **Verificado end-to-end**: `GET /` ok, `POST /predict/` multipart y base64 (incluido payload 1.74 MB) → `JNU540`, `/web/` ok, `/docs` ok.

## 🔎 8. Expediente de la placa (SIMIT / RUNT) — situación honesta

La app muestra un **expediente del vehículo** (comparendos, SOAT, revisión técnico‑mecánica) debajo de cada placa detectada, vía `GET /consulta/{placa}`.

- **Hoy devuelve datos DEMO** (`"fuente": "demo"`, badge amarillo en la app). Son **simulados pero deterministas**: la misma placa siempre da el mismo expediente, para que la demo sea consistente.
- **¿Por qué no datos reales?** SIMIT y RUNT **no tienen API pública gratuita**. La consulta de SIMIT está protegida con captcha y sus términos prohíben scraping automatizado (y se rompería a mitad de una clase). Por eso se construyó como **adaptador enchufable**, no como hack.
- **Cómo conectar una fuente real** (cuando se consigan credenciales de SIMIT/RUNT o un proveedor oficial de datos vehiculares): en `app.py` hay un diccionario `ADAPTERS`. Se escribe un `_adapter_real(placa) -> dict` con la misma forma y se registra; **no hace falta tocar la app** — solo `export CONSULTA_ADAPTER=real` y reiniciar el servicio. La UI ya pinta el badge en verde "OFICIAL" si `fuente != "demo"`.

## 📋 6b. Dónde se ven los LOGS

| Qué log | Dónde |
|---|---|
| **Peticiones al server** (quién envió, qué placa detectó, código HTTP) | `ssh -i llaveplaca.pem ubuntu@$SERVER_IP "journalctl -u yolo-plates --since '10 min ago' --no-pager"` (o `-f` para verlos en vivo) |
| **De la app (APK instalado)** | Con el celular por USB: `adb logcat -s ReactNativeJS` → muestra los `console.log`/`console.error` de la app |
| **De la app en Expo Go** | En la misma terminal donde corres `npx expo start` (salen en vivo) |

## 📦 7. APK nativo (sin Expo Go)

La app también está compilada como **APK de release firmado**, instalable directo en cualquier Android — ya no dependes de tu PC ni de Expo Go para la demo (solo internet en el celular).

- **👉 Usa este (última versión)**: `DetectorPlacas/APK/detector-placas-v1.2.0.apk` (69 MB, solo ARM) — freeze-frame al procesar + OCR server mucho más fiable y rápido
- Versiones anteriores conservadas: `v1.1.0` (69 MB), `v1.0.0` (127 MB)
- **Instalar**: pasa el archivo al celular (cable/WhatsApp/Drive), ábrelo y permite "instalar apps desconocidas" cuando lo pida. Si ya tienes la v1.0.0, instala la v1.1.0 encima sin desinstalar (misma firma) o usa `adb install -r`.
- **O por cable (recomendado, activa "Depuración USB" en Opciones de desarrollador):**
  ```bash
  "C:\Users\jose\AppData\Local\Android\Sdk\platform-tools\adb.exe" install -r DetectorPlacas/APK/detector-placas-v1.2.0.apk
  ```
- La app **ya trae precargada** la IP `$SERVER_IP` y puerto `8080` (tocables en ⚙ si cambias de servidor).

### Novedades de la v1.1.0 (rediseño)
| Función | Cómo se usa |
|---|---|
| 🧊 **v1.2.0 — Freeze-frame** | Al tomar la foto, la pantalla **se queda con la foto congelada** y el rótulo "Analizando esta foto…" — sabes que la app está procesando ESA toma (en modo continuo se actualiza como slideshow). Ya no confundas la cámara en vivo con "buscar otra vez" |
| 🎨 UI nueva | Tema noche con la placa detectada renderizada como placa colombiana real (amarilla, revelado animado carácter por carácter) |
| 🔄 Modo continuo | Botón **"Continuo"**: escanea solo cada ~2.5 s y **habla únicamente placas nuevas** (no repite). "Detener" lo apaga |
| 📋 Expediente del vehículo | Debajo de la placa: SOAT y revisión técnico-mecánica (vigencia) + comparendos con valores. Lleva badge **DEMO** (ver sección 8 sobre datos reales) |
| 🖼️ Foto analizada | "Ver foto analizada" muestra la imagen devuelta por el server con las cajas dibujadas (útil para explicar YOLO en la demo) |
| 🕒 Historial | Chips con las últimas 3 placas; tócalas para volver a ver su expediente |
| 🔊 Voz mejorada | Deletrea la placa ("J. N. U. cinco cuatro cero") en español |
| ⚡ Más rápida | La foto se comprime en el celular (calidad 0.75) antes de subirla: ~5 MB → ~1 MB |

### Cómo se regenera el APK tras cambios
```bash
# 1) Sincroniza el código a la máquina de build (path ASCII; el path con "é" rompe Gradle):
robocopy "D:\José Tellez\...\DetectorPlacas" C:\dev\DetectorPlacas /E /XD node_modules android
#    (y copia node_modules, o npm install en C:\dev)
# 2) Regenera android/ si cambió app.json o dependencias nativas:
cd /c/dev/DetectorPlacas && npx expo prebuild -p android --clean
# 3) ReAPLICAR tras prebuild: (a) bloque release en signingConfigs de android/app/build.gradle
#    (storeFile file('../release.keystore'), pass $KEYSTORE_PASS, alias detectorplacas) +
#    signingConfig signingConfigs.release en buildTypes.release; (b) copiar release.keystore a android/;
#    (c) android/local.properties -> sdk.dir=C:/Users/jose/AppData/Local/Android/Sdk
# 4) Compilar SOLO con ABIs de celular (mitad de peso):
cd android && JAVA_HOME="C:/Program Files/Java/jdk-23" ./gradlew assembleRelease --no-daemon -x lint -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
# 5) Verificar y publicar:
"/c/Users/jose/AppData/Local/Android/Sdk/build-tools/36.0.0/apksigner.bat" verify --print-certs app/build/outputs/apk/release/app-release.apk   # → CN=DetectorPlacas
cp app/build/outputs/apk/release/app-release.apk "/d/José Tellez/.../DetectorPlacas/APK/detector-placas-vX.Y.Z.apk"
```
> ℹ️ `-PreactNativeArchitectures` es el knob OFICIAL de React Native para filtrar ABIs (un `ndk.abiFilters` manual en build.gradle es ignorado en RN 0.86 — así se pasó de 127 → 69 MB).
> ℹ️ **Si haces bump de versión SIN `prebuild`**: `android/app/build.gradle` conserva el `versionName` viejo (es copia generada); edítalo a mano (`sed -i 's/versionName "X"/versionName "Y"/'`) o el APK saldrá con la versión anterior en `aapt2 dump badging`.
> ⚠️ `expo prebuild` borra el parche de signing: sin el paso 3 el APK sale firmado con clave de **debug** y no actualizará sobre el instalado.
> ⚠️ **GUARDA BIEN `DetectorPlacas/release.keystore`** (contraseña: `$KEYSTORE_PASS`, alias `detectorplacas`). Sin ese archivo NO podrás publicar actualizaciones firmadas de esta misma app. Está excluido del git (`.gitignore`) a propósito.

## ✅ Checklist para tu clase/demo

1. `ssh -i llaveplaca.pem ubuntu@$SERVER_IP` → `sudo systemctl status yolo-plates` (debe decir *active (running)*).
2. `curl http://$SERVER_IP:8080/` (debe responder JSON).
3. **Opción simple (recomendada para demo):** instala el **APK v1.1.0** del cel (sección 7) → abre la app (IP ya precargada) → apunta a un carro → 🎉 placa animada + expediente + voz. Para lucerte: activa **"Continuo"** y pasa carros (o fotos) uno por uno.
4. **Opción desarrollo (desde PC):** `cd DetectorPlacas && npx expo start -c` → escanea con Expo Go → misma IP/puerto.
5. Si alguien pregunta por SIMIT/RUNT: explica el diseño de adaptadores con honestidad (sección 8) — demuestra más madurez que un dato "mágico".
