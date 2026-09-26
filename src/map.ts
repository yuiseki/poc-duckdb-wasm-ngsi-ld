// The map: entity points, query shapes and the two drawing modes. It knows
// nothing about NGSI-LD; main.ts turns what is drawn here into broker requests.
import { Map as MapLibreMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre v6 cannot locate its worker from inside a bundle.
setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tile.yuiseki.net/styles/osm-liberty/style.json';
const TOKYO: [number, number] = [139.7671, 35.6812];

export const TYPE_COLORS: Record<string, string> = {
  Restaurant: '#e8590c',
  Shop: '#1c7ed6',
  HealthcareFacility: '#e03131',
  PublicFacility: '#2f9e44',
  EducationFacility: '#f08c00',
  PlaceOfWorship: '#7048e8',
  TouristAttraction: '#c2255c',
  Station: '#212529',
  EmergencyFacility: '#fa5252',
};

type Mode = 'near' | 'within';
type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;
const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

/** A plain style used when the online basemap cannot be fetched. */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ecef' } }],
};

async function loadStyle(): Promise<{ style: StyleSpecification | string; online: boolean }> {
  try {
    const res = await fetch(STYLE_URL, { signal: AbortSignal.timeout(4000) });
    if (res.ok) return { style: (await res.json()) as StyleSpecification, online: true };
  } catch {
    /* offline or blocked: fall through */
  }
  return { style: FALLBACK_STYLE, online: false };
}

export class EntityMap {
  mode: Mode = 'near';
  basemapOnline = false;
  private vertices: [number, number][] = [];
  onNear: (lngLat: [number, number]) => void = () => {};
  onWithin: (ring: [number, number][]) => void = () => {};

  private constructor(readonly map: MapLibreMap) {}

  static async create(container: HTMLElement, wardsUrl: string): Promise<EntityMap> {
    const { style, online } = await loadStyle();
    const map = new MapLibreMap({ container, style, center: TOKYO, zoom: 11.5, attributionControl: { compact: true } });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    // Keep the centre clear of the side panel on wide screens.
    if (container.clientWidth > 720) map.setPadding({ left: 420, top: 0, right: 0, bottom: 0 });
    await map.once('load');
    const m = new EntityMap(map);
    m.basemapOnline = online;
    m.addLayers(wardsUrl);
    m.bindEvents();
    return m;
  }

  private addLayers(wardsUrl: string) {
    const map = this.map;
    map.addSource('wards', { type: 'geojson', data: wardsUrl });
    map.addLayer({ id: 'wards-line', type: 'line', source: 'wards', paint: { 'line-color': '#495057', 'line-width': 1.5, 'line-dasharray': [3, 2] } });

    const color: any = ['match', ['get', 'type'], ...Object.entries(TYPE_COLORS).flat(), '#868e96'];
    map.addSource('entities', {
      type: 'geojson',
      data: empty(),
      attribution: 'Entities: <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> (ODbL)',
    });
    map.addLayer({
      id: 'entities',
      type: 'circle',
      source: 'entities',
      paint: {
        'circle-color': color,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 14, 3, 17, 6],
        'circle-opacity': 0.55,
      },
    });

    map.addSource('shape', { type: 'geojson', data: empty() });
    map.addLayer({ id: 'shape-fill', type: 'fill', source: 'shape', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#1971c2', 'fill-opacity': 0.08 } });
    map.addLayer({ id: 'shape-line', type: 'line', source: 'shape', paint: { 'line-color': '#1971c2', 'line-width': 2 } });
    map.addLayer({ id: 'shape-points', type: 'circle', source: 'shape', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#1971c2' } });

    // A small source of just the matches: filtering the 73k-point source instead
    // would make MapLibre rebuild every tile of it on each query.
    map.addSource('results', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'results',
      type: 'circle',
      source: 'results',
      paint: {
        'circle-color': color,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5, 17, 8],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1,
      },
    });
  }

  private bindEvents() {
    const map = this.map;
    map.on('click', (e) => {
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (this.mode === 'near') return this.onNear(p);
      // Clicking near the first vertex closes the ring.
      if (this.vertices.length >= 3) {
        const first = map.project(this.vertices[0]);
        if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) return this.finishPolygon();
      }
      this.vertices.push(p);
      this.drawVertices();
    });
    map.on('dblclick', (e) => {
      if (this.mode !== 'within') return;
      e.preventDefault();
      this.finishPolygon();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancelPolygon();
      if (e.key === 'Enter' && this.mode === 'within') this.finishPolygon();
    });
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.cancelPolygon();
    if (mode === 'within') this.map.doubleClickZoom.disable();
    else this.map.doubleClickZoom.enable();
    this.map.getCanvas().style.cursor = 'crosshair';
  }

  private drawVertices() {
    const features: Feature[] = this.vertices.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
    if (this.vertices.length >= 2) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.vertices } });
    }
    this.setShape(features);
  }

  finishPolygon() {
    if (this.vertices.length < 3) return;
    const ring = [...this.vertices, this.vertices[0]];
    this.vertices = [];
    this.setShape([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }]);
    this.onWithin(ring);
  }

  cancelPolygon() {
    if (!this.vertices.length) return;
    this.vertices = [];
    this.setShape([]);
  }

  showCircle(center: [number, number], metres: number) {
    this.setShape([
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circle(center, metres)] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: center } },
    ]);
  }

  private setShape(features: Feature[]) {
    (this.map.getSource('shape') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  setEntities(fc: GeoJSON.FeatureCollection) {
    (this.map.getSource('entities') as GeoJSONSource).setData(fc);
  }

  setResults(features: GeoJSON.Feature[]) {
    (this.map.getSource('results') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  /** Resolves once MapLibre has finished loading and drawing what it has. */
  idle(): Promise<void> {
    // Ask for a frame so an already idle map fires 'idle' again instead of never.
    const done = new Promise<void>((resolve) => this.map.once('idle', () => resolve()));
    this.map.triggerRepaint();
    return done;
  }

  clear() {
    this.vertices = [];
    this.setShape([]);
    this.setResults([]);
  }
}

/** A ring approximating a circle of `metres` around `center` on a sphere. */
export function circle([lon, lat]: [number, number], metres: number, steps = 64): [number, number][] {
  const R = 6_371_008.8;
  const d = metres / R;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const θ = (2 * Math.PI * i) / steps;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
    ring.push([(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI]);
  }
  return ring;
}
