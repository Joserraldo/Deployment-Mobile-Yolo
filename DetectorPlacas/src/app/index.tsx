import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const INSET_ABSOLUTE = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

/* ==========================================================================
   Detector de Placas — pantalla principal (v1.1.0 rediseño)
   Identidad visual: la placa colombiana sobre asfalto nocturno.
   ========================================================================== */

// ---------- Tokens de diseño ----------
const C = {
  asphalt: '#0E1116',
  surface: '#171C23',
  surfaceAlt: '#20272F',
  line: '#2B333D',
  plate: '#FFD200',
  plateInk: '#15181D',
  live: '#3ECF8E',
  alert: '#E5484D',
  text: '#EEF1F5',
  muted: '#98A2AE',
  dim: '#5C6670',
};

// ---------- Config de operación ----------
// El servidor se configura en DetectorPlacas/.env (EXPO_PUBLIC_SERVER_HOST/PORT);
// sin .env, el usuario lo escribe en la app (⚙).
const DEFAULT_IP = process.env.EXPO_PUBLIC_SERVER_HOST ?? '';
const DEFAULT_PORT = process.env.EXPO_PUBLIC_SERVER_PORT ?? '8080';
const CAPTURE_QUALITY = 0.75;
const CONTINUOUS_MS = 2500;
const MAX_HISTORY = 3;

// ---------- Tipos ----------
type Phase = 'idle' | 'capturando' | 'procesando' | 'ok' | 'noplate' | 'error';

interface Comparendo {
  fecha: string;
  codigo_infraccion: string;
  descripcion: string;
  valor_COP: number;
  ciudad: string;
  estado: string;
}

interface Expediente {
  placa: string;
  fuente: string;
  aviso: string;
  comparendos: Comparendo[];
  total_comparendos: number;
  deuda_total_COP: number;
  soat: { vigencia_fin: string; vigente: boolean };
  revision_tecnico_mecanica: { vigencia_fin: string; vigente: boolean };
}

interface Resultado {
  placa: string;
  imagenProcesada: string | null;
  expediente?: Expediente;
  ts: number;
}

// ---------- Utilidades ----------
const DIGITOS: Record<string, string> = {
  '0': 'cero', '1': 'uno', '2': 'dos', '3': 'tres', '4': 'cuatro',
  '5': 'cinco', '6': 'seis', '7': 'siete', '8': 'ocho', '9': 'nueve',
};

/** Convierte "JNU540" en texto que el TTS en español deletrea bien. */
function speakablePlate(plate: string): string {
  const chars = plate.split('').map((ch) => (/\d/.test(ch) ? `${DIGITOS[ch] ?? ch},` : `${ch}.`));
  return `La placa detectada es ${chars.join(' ')}`;
}

function fmtCOP(n: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', maximumFractionDigits: 0,
  }).format(n);
}

function fmtFecha(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------- Célula de la placa (el protagonista) ----------
function PlateCell({ ch, index, reduced }: { ch: string; index: number; reduced: boolean }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) { anim.setValue(1); return; }
    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1, duration: 260, delay: 90 + index * 70,
      easing: Easing.out(Easing.back(2)), useNativeDriver: true,
    }).start();
  }, [ch, index]);
  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [
          { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
          { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
        ],
      }}>
      <Text style={styles.plateChar}>{ch}</Text>
    </Animated.View>
  );
}

// ---------- Chip de estado (SOAT / RTM) ----------
function VigenciaChip({ label, status }: { label: string; status: { vigencia_fin: string; vigente: boolean } }) {
  const ok = status.vigente;
  const fecha = fmtFecha(status.vigencia_fin);
  return (
    <View style={[styles.chip, { borderColor: ok ? C.live : C.alert }]}>
      <View style={[styles.chipDot, { backgroundColor: ok ? C.live : C.alert }]} />
      <View>
        <Text style={styles.chipLabel}>{label}</Text>
        <Text style={styles.chipValue}>{ok ? `Vigente · ${fecha}` : `Vencido · ${fecha}`}</Text>
      </View>
    </View>
  );
}

export default function CameraScreen() {
  const cameraRef = useRef<any>(null);
  const [permission, requestPermission] = useCameraPermissions();

  // Conexión
  const [ip, setIp] = useState(DEFAULT_IP);
  const [port, setPort] = useState(DEFAULT_PORT);
  const [showSettings, setShowSettings] = useState(false);

  // Estado de la interfaz
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<Resultado | null>(null);
  const [history, setHistory] = useState<Resultado[]>([]);
  const [continuous, setContinuous] = useState(false);
  const [showAnalyzed, setShowAnalyzed] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [frozenUri, setFrozenUri] = useState<string | null>(null);

  // Refs para el bucle continuo (evitan cierres obsoletos y re-creaciones)
  const busyRef = useRef(false);
  const spokenRef = useRef<Set<string>>(new Set());
  const apiRef = useRef('');
  const continuousRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const apiUrl = useMemo(() => (ip && port ? `http://${ip.trim()}:${port.trim()}` : ''), [ip, port]);
  apiRef.current = apiUrl;

  // Sweep de escaneo (línea que barre el visor)
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => setReduced(false));
  }, []);

  useEffect(() => {
    if (!permission?.granted && Platform.OS !== 'web') {
      // Expo ya pide el permiso del sistema; no insistimos aquí.
    }
  }, [permission]);

  // Animación continua del sweep mientras escanea
  useEffect(() => {
    const scanning = phase === 'capturando' || phase === 'procesando' || continuous;
    if (!scanning || reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(sweep, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, continuous, reduced]);

  const vibrate = useCallback(() => {
    if (Platform.OS === 'web') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }, []);

  const say = useCallback((text: string) => {
    if (Platform.OS === 'web') return;
    Speech.stop();
    Speech.speak(text, { language: 'es-CO' });
  }, []);

  /** Un ciclo de captura → predict → expediente. */
  const runCapture = useCallback(async (opts: { silentNoPlate: boolean }) => {
    if (busyRef.current) return;
    const api = apiRef.current;
    if (!cameraRef.current || !api) {
      setErrorMsg('Configura el servidor en ⚙');
      setPhase('error');
      return;
    }
    busyRef.current = true;
    setPhase((p) => (p === 'ok' || p === 'noplate' ? p : 'capturando'));
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: CAPTURE_QUALITY });
      if (!photo?.base64) throw new Error('sin imagen');
      setFrozenUri(photo.uri); // congelamos la toma: el usuario ve QUÉ foto se está analizando
      setPhase('procesando');

      const form = new URLSearchParams();
      form.append('image_base64', photo.base64);
      const res = await fetch(`${api.replace(/\/$/, '')}/predict/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const placas: string[] = data?.placas ?? [];
      if (placas.length > 0) {
        const plate = placas[0];
        const isNew = !spokenRef.current.has(plate);
        let expediente: Expediente | undefined;
        try {
          const r = await fetch(`${api.replace(/\/$/, '')}/consulta/${encodeURIComponent(plate)}`);
          if (r.ok) expediente = await r.json();
        } catch { /* expediente es opcional */ }

        const newResult: Resultado = {
          placa: plate,
          imagenProcesada: data.image ? `data:image/jpeg;base64,${data.image}` : null,
          expediente,
          ts: Date.now(),
        };
        setResult(newResult);
        setShowAnalyzed(false);
        setHistory((h) => {
          const next = [newResult, ...h.filter((x) => x.placa !== plate)].slice(0, MAX_HISTORY);
          return next;
        });
        setPhase('ok');
        if (isNew) {
          spokenRef.current.add(plate);
          vibrate();
          say(speakablePlate(plate));
        }
      } else {
        if (!opts.silentNoPlate) {
          setPhase('noplate');
          setErrorMsg(null);
        } else {
          setPhase((p) => (p === 'ok' ? 'ok' : 'noplate'));
        }
      }
    } catch (e: any) {
      setErrorMsg(
        String(e?.message ?? e).includes('HTTP')
          ? `El servidor rechazó la imagen (${e.message}). Revisa la conexión e intenta de nuevo.`
          : 'No se pudo contactar el servidor. Verifica la IP y que tengas internet.',
      );
      setPhase('error');
      if (!opts.silentNoPlate) say('Error de conexión con el servidor');
    } finally {
      busyRef.current = false;
    }
  }, [vibrate, say]);

  // Bucle de modo continuo
  useEffect(() => {
    continuousRef.current = continuous;
    if (continuous) {
      intervalRef.current = setInterval(() => {
        void runCapture({ silentNoPlate: true });
      }, CONTINUOUS_MS);
      void runCapture({ silentNoPlate: true });
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [continuous, runCapture]);

  // ---------- Pantallas de permiso ----------
  if (!permission) {
    return (
      <View style={[styles.full, styles.center]}>
        <Text style={styles.mutedText}>Encendiendo la cámara…</Text>
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={[styles.full, styles.center, { padding: 24 }]}>
        <Text style={styles.bigTitle}>Permiso de cámara requerido</Text>
        <Text style={[styles.mutedText, { marginTop: 8, textAlign: 'center' }]}>
          El detector necesita la cámara para leer las placas.
        </Text>
        <Pressable style={styles.primaryBtn} onPress={requestPermission}>
          <Text style={styles.primaryBtnText}>Activar cámara</Text>
        </Pressable>
      </View>
    );
  }

  const phaseLabel = continuous
    ? 'Escaneo continuo'
    : phase === 'capturando' ? 'Capturando…'
    : phase === 'procesando' ? 'Analizando…'
    : phase === 'error' ? 'Sin conexión'
    : phase === 'noplate' ? 'Sin placa en el encuadre'
    : 'Listo para escanear';

  return (
    <View style={styles.full}>
      {/* ---- Encabezado ---- */}
      <View style={styles.header}>
        <View style={styles.statusPill}>
          <View style={[styles.dot, { backgroundColor: continuous || phase === 'procesando' ? C.live : C.dim }]} />
          <Text style={styles.statusText}>{phaseLabel}</Text>
        </View>
        <Pressable style={styles.serverPill} onPress={() => setShowSettings((s) => !s)}>
          <Text style={styles.serverPillText} numberOfLines={1}>{ip ? `${ip}:${port}` : 'sin servidor ⚙'}</Text>
          <Text style={styles.gear}>⚙</Text>
        </Pressable>
      </View>

      {/* ---- Ajustes de servidor ---- */}
      {showSettings && (
        <View style={styles.settings}>
          <Text style={styles.settingsLabel}>Dirección del servidor</Text>
          <View style={styles.settingsRow}>
            <TextInput
              style={[styles.input, { flex: 2 }]} value={ip} onChangeText={setIp}
              placeholder="IP o dominio" placeholderTextColor={C.dim}
              autoCapitalize="none" autoCorrect={false} keyboardType="url"
            />
            <TextInput
              style={[styles.input, { flex: 1 }]} value={port} onChangeText={setPort}
              placeholder="8080" placeholderTextColor={C.dim} keyboardType="number-pad" maxLength={5}
            />
          </View>
          <Text style={styles.settingsHint}>Ya viene con el servidor en la nube; cámbialo solo si usas uno local.</Text>
        </View>
      )}

      {/* ---- Visor ---- */}
      <View style={styles.cameraWrap}>
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
        {/* Foto congelada mientras se analiza (el usuario ve qué foto se está procesando) */}
        {frozenUri && (continuous || phase === 'capturando' || phase === 'procesando') && (
          <View style={INSET_ABSOLUTE} pointerEvents="none">
            <Image source={{ uri: frozenUri }} style={INSET_ABSOLUTE} resizeMode="cover" />
            <View style={styles.frozenBadge}>
              <Text style={styles.frozenBadgeText}>Analizando esta foto…</Text>
            </View>
          </View>
        )}
        {/* Retícula */}
        <View pointerEvents="none" style={styles.reticle}>
          <View style={[styles.corner, styles.cornerTL]} />
          <View style={[styles.corner, styles.cornerTR]} />
          <View style={[styles.corner, styles.cornerBL]} />
          <View style={[styles.corner, styles.cornerBR]} />
          <Animated.View
            style={[
              styles.sweepLine,
              {
                opacity: continuous || phase === 'procesando' ? 1 : 0,
                transform: [{
                  translateY: sweep.interpolate({ inputRange: [0, 1], outputRange: [0, 240] }),
                }],
              },
            ]}
          />
        </View>
      </View>

      {/* ---- Panel de resultado ---- */}
      <View style={styles.panel}>
        {phase === 'error' && errorMsg && (
          <View style={[styles.banner, { borderColor: C.alert }]}>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        )}
        {phase === 'noplate' && !result && (
          <View style={[styles.banner, { borderColor: C.line }]}>
            <Text style={styles.mutedText}>Enfoca una placa dentro de la retícula y vuelve a intentar.</Text>
          </View>
        )}

        {result ? (
          <>
            {/* La placa, como una placa real */}
            <View style={styles.plateCard}>
              <View style={styles.plateInner} key={result.placa}>
                {result.placa.split('').map((ch, i) => (
                  <PlateCell key={`${result.placa}-${i}`} ch={ch} index={i} reduced={reduced} />
                ))}
              </View>
              <View style={styles.plateStripe} />
              <Pressable onPress={() => setShowAnalyzed((v) => !v)} hitSlop={8}>
                <Text style={styles.analyzedToggle}>{showAnalyzed ? 'Ocultar análisis' : 'Ver foto analizada'}</Text>
              </Pressable>
            </View>

            {/* Expediente */}
            {result.expediente && (
              <View style={styles.expediente}>
                <View style={styles.expedienteHeader}>
                  <Text style={styles.expedienteTitle}>Expediente del vehículo</Text>
                  <View style={result.expediente.fuente === 'demo' ? styles.demoBadge : { ...styles.demoBadge, backgroundColor: '#0E4A2E' }}>
                    <Text style={result.expediente.fuente === 'demo' ? styles.demoBadgeText : { ...styles.demoBadgeText, color: C.live }}>
                      {result.expediente.fuente === 'demo' ? 'DEMO' : 'OFICIAL'}
                    </Text>
                  </View>
                </View>
                <View style={styles.chipsRow}>
                  <VigenciaChip label="SOAT" status={result.expediente.soat} />
                  <VigenciaChip label="RTM" status={result.expediente.revision_tecnico_mecanica} />
                </View>
                {result.expediente.total_comparendos > 0 ? (
                  <>
                    <Text style={styles.cmpSummary}>
                      {result.expediente.total_comparendos} comparendo(s) · deuda {fmtCOP(result.expediente.deuda_total_COP)}
                    </Text>
                    <ScrollView style={styles.cmpList} nestedScrollEnabled>
                      {result.expediente.comparendos.map((cmp, i) => (
                        <View key={i} style={styles.cmpRow}>
                          <View style={[styles.cmpFlag, { backgroundColor: cmp.estado === 'comparendo' ? C.alert : '#C77700' }]} />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.cmpTitle}>{cmp.codigo_infraccion} · {cmp.ciudad}</Text>
                            <Text style={styles.cmpDesc} numberOfLines={2}>{cmp.descripcion}</Text>
                            <Text style={styles.cmpMeta}>{fmtFecha(cmp.fecha)} — {fmtCOP(cmp.valor_COP)} · {cmp.estado}</Text>
                          </View>
                        </View>
                      ))}
                    </ScrollView>
                  </>
                ) : (
                  <Text style={styles.cleanText}>Sin comparendos registrados.</Text>
                )}
              </View>
            )}

            {showAnalyzed && result.imagenProcesada && (
              <Image source={{ uri: result.imagenProcesada }} style={styles.analyzedImg} resizeMode="contain" />
            )}
          </>
        ) : (
          <Text style={[styles.mutedText, { textAlign: 'center', marginBottom: 6 }]}>
            Coloca la placa dentro de la retícula.
          </Text>
        )}

        {/* Historial */}
        {history.length > 0 && (
          <View style={styles.historyRow}>
            {history.map((h) => (
              <Pressable
                key={h.ts}
                onPress={() => { setResult(h); setShowAnalyzed(false); setPhase('ok'); }}
                style={[styles.historyChip, result?.placa === h.placa && styles.historyChipActive]}>
                <Text style={styles.historyText}>{h.placa}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* ---- Barra de controles ---- */}
      <View style={styles.controls}>
        <Pressable
          style={[styles.toggle, continuous && styles.toggleOn]}
          onPress={() => { if (continuous) setFrozenUri(null); setContinuous((v) => !v); spokenRef.current = new Set(); }}>
          <Text style={[styles.toggleText, continuous && { color: C.plateInk }]}>
            {continuous ? 'Detener' : 'Continuo'}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => void runCapture({ silentNoPlate: false })}
          style={({ pressed }) => [styles.shutter, pressed && { transform: [{ scale: 0.92 }] }]}>
          <View style={styles.shutterInner}>
            <Text style={styles.shutterText}>{phase === 'procesando' ? '…' : '◎'}</Text>
          </View>
        </Pressable>

        <Pressable
          style={styles.toggle}
          onPress={() => { spokenRef.current = new Set(); setResult(null); setHistory([]); setPhase('idle'); setErrorMsg(null); }}>
          <Text style={[styles.toggleText]}>Limpiar</Text>
        </Pressable>
      </View>
    </View>
  );
}

const MONO_FONT = Platform.select({ android: 'monospace', ios: 'Menlo' });

/* ========================= Estilos ========================= */
const styles = StyleSheet.create({
  full: { flex: 1, backgroundColor: C.asphalt },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: Platform.OS === 'android' ? 40 : 56, paddingBottom: 10,
  },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: C.line,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: C.text, fontSize: 13, fontWeight: '600' },
  serverPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '38%',
    backgroundColor: C.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: C.line,
  },
  serverPillText: { color: C.muted, fontSize: 13 },
  gear: { color: C.muted, fontSize: 15 },

  settings: { paddingHorizontal: 14, paddingBottom: 10 },
  settingsLabel: { color: C.muted, fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 },
  settingsRow: { flexDirection: 'row', gap: 8 },
  input: {
    backgroundColor: C.surfaceAlt, borderColor: C.line, borderWidth: 1, borderRadius: 10,
    color: C.text, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15,
  },
  settingsHint: { color: C.dim, fontSize: 12, marginTop: 6 },

  cameraWrap: { flex: 1, marginHorizontal: 14, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' },
  reticle: { ...INSET_ABSOLUTE, alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', width: 30, height: 30, borderColor: C.plate },
  cornerTL: { top: 26, left: 26, borderTopWidth: 3.5, borderLeftWidth: 3.5, borderTopLeftRadius: 10 },
  cornerTR: { top: 26, right: 26, borderTopWidth: 3.5, borderRightWidth: 3.5, borderTopRightRadius: 10 },
  cornerBL: { bottom: 26, left: 26, borderBottomWidth: 3.5, borderLeftWidth: 3.5, borderBottomLeftRadius: 10 },
  cornerBR: { bottom: 26, right: 26, borderBottomWidth: 3.5, borderRightWidth: 3.5, borderBottomRightRadius: 10 },
  sweepLine: {
    position: 'absolute', top: '42%', width: '76%', height: 2,
    backgroundColor: C.live, shadowColor: C.live, shadowRadius: 8, shadowOpacity: 0.9, shadowOffset: { width: 0, height: 0 },
  },
  frozenBadge: {
    position: 'absolute', bottom: 18, alignSelf: 'center',
    backgroundColor: 'rgba(14,17,22,0.85)', borderColor: C.plate, borderWidth: 1,
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7,
  },
  frozenBadgeText: { color: C.plate, fontSize: 13, fontWeight: '700' },

  panel: { paddingHorizontal: 14, paddingTop: 12, gap: 10 },
  banner: { borderWidth: 1, borderRadius: 12, padding: 12, backgroundColor: C.surface },
  errorText: { color: C.alert, fontSize: 13.5, lineHeight: 19 },
  bigTitle: { color: C.text, fontSize: 20, fontWeight: '800' },
  mutedText: { color: C.muted, fontSize: 13.5 },
  primaryBtn: { backgroundColor: C.plate, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 13, marginTop: 20 },
  primaryBtnText: { color: C.plateInk, fontSize: 15, fontWeight: '900' },

  plateCard: { backgroundColor: C.surface, borderRadius: 16, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.line },
  plateInner: {
    flexDirection: 'row', backgroundColor: C.plate, borderRadius: 8,
    paddingHorizontal: 18, paddingVertical: 12, borderWidth: 3, borderColor: '#0B0D10',
  },
  plateChar: {
    color: C.plateInk, fontSize: 34, fontWeight: '900', letterSpacing: 2,
    marginHorizontal: 2, fontFamily: MONO_FONT,
  },
  plateStripe: { width: 56, height: 3, borderRadius: 2, backgroundColor: '#0B0D10', opacity: 0.35, marginTop: 8 },
  analyzedToggle: { color: C.muted, fontSize: 12.5, marginTop: 8 },
  analyzedImg: { width: '100%', height: 190, borderRadius: 12, backgroundColor: '#000' },

  expediente: { backgroundColor: C.surface, borderRadius: 16, padding: 12, borderWidth: 1, borderColor: C.line },
  expedienteHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  expedienteTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  demoBadge: { backgroundColor: '#7A6400', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  demoBadgeText: { color: C.plate, fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },
  chipsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    flex: 1, minWidth: 140, flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 10, padding: 10, backgroundColor: C.surfaceAlt,
  },
  chipDot: { width: 9, height: 9, borderRadius: 5 },
  chipLabel: { color: C.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  chipValue: { color: C.text, fontSize: 12.5, fontWeight: '600' },
  cmpSummary: { color: C.text, fontSize: 13, marginTop: 10, fontWeight: '700' },
  cmpList: { maxHeight: 132, marginTop: 6 },
  cmpRow: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line },
  cmpFlag: { width: 4, borderRadius: 2 },
  cmpTitle: { color: C.text, fontSize: 12.5, fontWeight: '700' },
  cmpDesc: { color: C.muted, fontSize: 12 },
  cmpMeta: { color: C.dim, fontSize: 11.5, marginTop: 2 },
  cleanText: { color: C.live, fontSize: 13, marginTop: 10, fontWeight: '600' },

  historyRow: { flexDirection: 'row', gap: 8 },
  historyChip: {
    backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.line,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
  },
  historyChipActive: { borderColor: C.plate },
  historyText: { color: C.text, fontSize: 12.5, fontWeight: '700', letterSpacing: 1 },

  controls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 22, paddingTop: 12, paddingBottom: Platform.OS === 'android' ? 26 : 34,
  },
  toggle: {
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.line,
    borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, minWidth: 84, alignItems: 'center',
  },
  toggleOn: { backgroundColor: C.plate, borderColor: C.plate },
  toggleText: { color: C.muted, fontSize: 13, fontWeight: '700' },
  shutter: {
    width: 74, height: 74, borderRadius: 37, backgroundColor: C.surface,
    borderWidth: 3, borderColor: C.plate, alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.plate, alignItems: 'center', justifyContent: 'center' },
  shutterText: { color: C.plateInk, fontSize: 26, fontWeight: '900' },
});
