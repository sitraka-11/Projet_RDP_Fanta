import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Zap,
  Plus,
  Info,
  Coins,
  CupSoda,
  Banknote,
  UserCheck,
  Sparkles,
  CheckCircle2,
  XCircle,
  Wallet,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// MODELE RDP : Distributeur automatique de boissons (5 transitions)
// — version avec gestion réaliste du paiement progressif —
//
// Scénario : un client insère de l'argent, éventuellement en plusieurs fois
// (montant CUMULÉ, jamais perdu). Une garde compare montantInsere au prix :
//   - insuffisant  -> la machine attend un complément (boucle "ajouter
//     argent" -> vérification, sans jamais réinitialiser le montant déjà
//     inséré)
//   - exact        -> la préparation démarre, aucune monnaie à rendre
//   - supérieur     -> la préparation démarre, la monnaie sera rendue au
//     moment du service (fork T4)
//
// Un Réseau de Pétri "pur" ne compare pas des entiers arbitraires : ici, le
// marquage (0/1) reste la structure RDP (places/transitions/arcs), et la
// comparaison montantInsere/prixBoisson est une GARDE externe qui décide si
// T1/T2/T4/T5 sont franchissables — comme les gardes d'un RDP coloré (le
// jeton "porte" une valeur, ici montantInsere).
//
// Places :
//   ClientPret     : la machine est prête à accepter un nouveau client
//   MontantInsere  : jeton présent <=> une transaction de paiement est en
//                     cours (la VALEUR réelle est suivie à part, dans l'état
//                     `montant`, car un jeton RDP classique ne porte pas de
//                     valeur numérique)
//   MachineLibre   : jeton présent <=> la machine est disponible (capacité 1)
//   EnPreparation  : boisson en cours de préparation
//   BoissonPrete   : boisson prête, avant le fork service/monnaie
//   Servie         : la boisson a été servie (branche 1 du fork)
//   MonnaieRendue  : la monnaie a été rendue (branche 2 du fork, seulement si
//                     monnaie > 0)
//   ClientsServis  : compteur de clients servis (après le join)
//
// Transitions :
//   T1 "Insérer de l'argent"   : ClientPret -> MontantInsere, puis chaque
//     pièce/billet supplémentaire boucle sur MontantInsere tant que le
//     montant est insuffisant (montant += valeur, sans jamais revenir à 0)
//   T2 "Démarrer la préparation" (gardée : montant >= prixBoisson)
//                                : MontantInsere + MachineLibre -> EnPreparation
//   T3 "Préparation terminée"   : EnPreparation -> BoissonPrete + MachineLibre
//   T4 "Servir (+ rendre monnaie si monnaie > 0)" (FORK conditionnel)
//                                : BoissonPrete -> Servie [+ MonnaieRendue]
//   T5 "Client repart" (JOIN conditionnel, n'exige MonnaieRendue que si une
//     monnaie était due) : Servie [+ MonnaieRendue] -> ClientsServis, puis
//     réinitialisation de montant/monnaie et réarmement de ClientPret pour
//     le client suivant
//
// Invariant : M(MachineLibre) + M(EnPreparation) = 1 (exclusion mutuelle).
// ---------------------------------------------------------------------------

const PRIX_BOISSON = 3000;
const DENOMINATIONS = [500, 1000, 2000, 5000, 10000];

const INITIAL_MARKING = {
  ClientPret: 1,
  MontantInsere: 0,
  MachineLibre: 1,
  EnPreparation: 0,
  BoissonPrete: 0,
  Servie: 0,
  MonnaieRendue: 0,
  ClientsServis: 0,
};

// Définitions "métier" (indépendantes de la mise en page) : identifiants,
// libellés, couleurs, arcs entrants/sortants. Les coordonnées x/y sont
// fournies séparément pour deux variantes de mise en page (bureau / mobile),
// afin que le diagramme reste entièrement lisible sans scroll horizontal ni
// texte minuscule sur petit écran.
const PLACE_DEFS = [
  { id: "ClientPret", label: "Clients prêts", color: "#60a5fa" },
  { id: "MontantInsere", label: "Montant inséré", color: "#60a5fa" },
  { id: "MachineLibre", label: "Machine libre", color: "#22c55e" },
  { id: "EnPreparation", label: "Préparation", color: "#f5a623" },
  { id: "BoissonPrete", label: "Boisson prête", color: "#c084fc" },
  { id: "Servie", label: "Boisson servie", color: "#22c55e" },
  { id: "MonnaieRendue", label: "Monnaie rendue", color: "#22c55e" },
  { id: "ClientsServis", label: "Clients servis", color: "#38bdf8" },
];

// NB : les inputs/outputs ci-dessous décrivent la structure "nominale" du
// RDP pour le diagramme et le calcul des arcs. Le franchissement réel de
// T1/T2/T4/T5 est piloté par les gardes définies dans le composant (voir
// `enabledFor` et `doFire`), car ces transitions dépendent de la valeur
// numérique du paiement, pas seulement de la présence de jetons.
const TRANSITION_DEFS = [
  {
    id: "T1",
    inputs: { ClientPret: 1 },
    outputs: { MontantInsere: 1 },
    desc: "Le client insère de l'argent (montant cumulé)",
  },
  {
    id: "T2",
    inputs: { MontantInsere: 1, MachineLibre: 1 },
    outputs: { EnPreparation: 1 },
    desc: "Paiement suffisant : la machine démarre la préparation",
  },
  {
    id: "T3",
    inputs: { EnPreparation: 1 },
    outputs: { BoissonPrete: 1, MachineLibre: 1 },
    desc: "Fanta Orange prête, la machine se libère",
  },
  {
    id: "T4",
    inputs: { BoissonPrete: 1 },
    outputs: { Servie: 1, MonnaieRendue: 1 },
    desc: "Fork — le Fanta Orange est servi, la monnaie est rendue si elle est due",
  },
  {
    id: "T5",
    inputs: { Servie: 1, MonnaieRendue: 1 },
    outputs: { ClientsServis: 1 },
    desc: "Join — le client repart une fois les deux actions terminées",
  },
];

// Mise en page BUREAU : une seule ligne horizontale (viewBox large).
const PLACE_COORDS_DESKTOP = {
  ClientPret: { x: 55, y: 260 },
  MontantInsere: { x: 235, y: 260 },
  MachineLibre: { x: 330, y: 400 },
  EnPreparation: { x: 420, y: 260 },
  BoissonPrete: { x: 605, y: 260 },
  Servie: { x: 790, y: 130 },
  MonnaieRendue: { x: 790, y: 390 },
  ClientsServis: { x: 960, y: 260 },
};
const TRANSITION_COORDS_DESKTOP = {
  T1: { x: 145, y: 260 },
  T2: { x: 330, y: 260 },
  T3: { x: 510, y: 260 },
  T4: { x: 700, y: 260 },
  T5: { x: 880, y: 260 },
};

// Mise en page MOBILE : flux vertical en une colonne principale, avec deux
// petites branches parallèles (Machine libre, puis Servie/Monnaie rendue)
// décalées sur le côté. Tient dans la largeur de l'écran sans scroll
// horizontal, et les nœuds/textes sont dimensionnés en conséquence (voir
// `mobile` prop de PlaceNode/TransitionNode) pour rester nets à taille quasi
// réelle plutôt qu'écrasés par une forte réduction d'échelle.
const PLACE_COORDS_MOBILE = {
  ClientPret: { x: 70, y: 80 },
  MontantInsere: { x: 70, y: 245 },
  MachineLibre: { x: 270, y: 350 },
  EnPreparation: { x: 70, y: 410 },
  BoissonPrete: { x: 70, y: 575 },
  Servie: { x: 70, y: 825 },
  MonnaieRendue: { x: 260, y: 740 },
  ClientsServis: { x: 70, y: 990 },
};
const TRANSITION_COORDS_MOBILE = {
  T1: { x: 70, y: 163 },
  T2: { x: 170, y: 350 },
  T3: { x: 70, y: 493 },
  T4: { x: 70, y: 657 },
  T5: { x: 70, y: 908 },
};

function buildLayout(placeCoords, transitionCoords) {
  const places = PLACE_DEFS.map((p) => ({ ...p, ...placeCoords[p.id] }));
  const transitions = TRANSITION_DEFS.map((t) => ({ ...t, ...transitionCoords[t.id] }));
  return { places, transitions };
}

const DESKTOP_LAYOUT = buildLayout(PLACE_COORDS_DESKTOP, TRANSITION_COORDS_DESKTOP);
const MOBILE_LAYOUT = buildLayout(PLACE_COORDS_MOBILE, TRANSITION_COORDS_MOBILE);

// Moteur générique (conservé) — utilisé pour T3 qui n'a pas de garde numérique.
function isEnabled(t, marking) {
  return Object.entries(t.inputs).every(([p, qty]) => (marking[p] || 0) >= qty);
}
function fireTransition(t, marking) {
  const next = { ...marking };
  Object.entries(t.inputs).forEach(([p, qty]) => (next[p] -= qty));
  Object.entries(t.outputs).forEach(([p, qty]) => (next[p] = (next[p] || 0) + qty));
  return next;
}

// --- composants visuels du diagramme RDP -----------------------------------

// `mobile` agrandit nettement le texte et les nœuds : la mise en page
// mobile est affichée à une échelle proche du 1:1 (pas de forte réduction
// via viewBox), donc des tailles plus généreuses restent nettes au lieu
// d'être écrasées/floues comme sur l'ancienne mise en page unique.
// Tailles volontairement GÉNÉREUSES : le SVG est réduit à l'écran (viewBox
// 1050 px de large affiché dans ~700-900 px), donc les polices sont
// définies en unités du viewBox pour rester >= 12 px réels.
const TXT_HALO = {
  paintOrder: "stroke",
  stroke: "#0b0d12",
  strokeWidth: 5,
  strokeLinejoin: "round",
};
const COLOR_ID = "#f3f4f6"; // identifiant (ClientPret, T1…)
const COLOR_LABEL = "#d1d5db"; // libellé sous le nœud
const COLOR_ARC = "#8b94a7";

function PlaceNode({ place, tokens, mobile }) {
  const r = mobile ? 34 : 38;
  const idSize = mobile ? 15 : 16;
  const labelSize = mobile ? 14 : 17;
  const tokenSize = mobile ? 20 : 26;
  // Bureau : MachineLibre (arc vertical vers T2) et MonnaieRendue (arcs
  // venant du haut) ont leur nom et libellé SOUS le cercle pour éviter toute collision.
  const below = !mobile && (place.id === "MachineLibre" || place.id === "MonnaieRendue");
  // Mobile : colonne principale -> textes À DROITE du cercle (les flèches
  // verticales ne les traversent plus) ; branches -> textes empilés au-dessus.
  const side = mobile && place.id !== "MachineLibre" && place.id !== "MonnaieRendue";
  const stacked = mobile && !side;
  const textX = side ? place.x + r + 12 : place.x;
  const anchor = side ? "start" : "middle";
  const idY = side ? place.y - 4 : stacked ? place.y - r - 32 : below ? place.y + r + 24 : place.y - r - 14;
  const labelY = side ? place.y + 17 : stacked ? place.y - r - 12 : below ? place.y + r + 46 : place.y + r + 24;
  return (
    <g>
      <circle
        cx={place.x}
        cy={place.y}
        r={r}
        fill="#12151c"
        stroke={tokens > 0 ? place.color : "#6b7385"}
        strokeWidth={tokens > 0 ? 4 : 2.5}
        style={{ transition: "stroke 400ms ease, stroke-width 400ms ease" }}
        vectorEffect="non-scaling-stroke"
      />
      {tokens > 0 && (
        <text
          key={tokens}
          x={place.x}
          y={place.y + tokenSize / 3}
          textAnchor="middle"
          fontSize={tokenSize}
          fontWeight="700"
          fontFamily="'JetBrains Mono', ui-monospace, monospace"
          fill={place.color}
          className="animate-pop"
          style={{ transformOrigin: `${place.x}px ${place.y}px` }}
        >
          {tokens}
        </text>
      )}
      <text
        x={textX}
        y={idY}
        textAnchor={anchor}
        fontSize={idSize}
        fontWeight="700"
        fill={COLOR_ID}
        fontFamily="'JetBrains Mono', ui-monospace, monospace"
        {...TXT_HALO}
      >
        {place.id}
      </text>
      <text
        x={textX}
        y={labelY}
        textAnchor={anchor}
        fontSize={labelSize}
        fontWeight="500"
        fill={COLOR_LABEL}
        {...TXT_HALO}
      >
        {place.label}
      </text>
    </g>
  );
}

// Position de l'étiquette (T1…T5) : choisie pour ne jamais être traversée
// par un arc (bureau = au-dessus/au-dessous, mobile = à gauche du rectangle).
const T_LABEL_POS_DESKTOP = { T1: "below", T2: "above", T3: "below", T4: "aboveLeft", T5: "belowRight" };
const T_LABEL_POS_MOBILE = { T1: "left", T2: "above", T3: "left", T4: "left", T5: "left" };

function TransitionNode({ t, enabled, onFire, mobile }) {
  const w = mobile ? 26 : 24;
  const h = mobile ? 46 : 44;
  const idSize = mobile ? 16 : 18;
  const pos = (mobile ? T_LABEL_POS_MOBILE : T_LABEL_POS_DESKTOP)[t.id] || "below";
  const lab = {
    below: { x: t.x, y: t.y + h / 2 + idSize + 4, a: "middle" },
    above: { x: t.x, y: t.y - h / 2 - 9, a: "middle" },
    aboveLeft: { x: t.x - 6, y: t.y - h / 2 - 9, a: "end" },
    belowRight: { x: t.x + 8, y: t.y + h / 2 + idSize + 4, a: "start" },
    left: { x: t.x - w / 2 - 9, y: t.y + idSize / 3, a: "end" },
  }[pos];
  return (
    <g onClick={() => enabled && onFire(t.id)} style={{ cursor: enabled ? "pointer" : "default" }}>
      <rect
        x={t.x - w / 2}
        y={t.y - h / 2}
        width={w}
        height={h}
        rx={5}
        fill={enabled ? "#f5a623" : "#2a2e3a"}
        stroke={enabled ? "#f5a623" : "#6b7385"}
        strokeWidth={2}
        style={{ transition: "all 250ms ease" }}
      />
      {enabled && (
        <rect
          x={t.x - w / 2}
          y={t.y - h / 2}
          width={w}
          height={h}
          rx={5}
          fill="none"
          stroke="#f5a623"
          strokeWidth={2}
          className="animate-glow-pulse"
        />
      )}
      <text
        x={lab.x}
        y={lab.y}
        textAnchor={lab.a}
        fontSize={idSize}
        fontWeight="800"
        fill={enabled ? "#fbbf24" : "#e5e7eb"}
        fontFamily="'JetBrains Mono', ui-monospace, monospace"
        {...TXT_HALO}
      >
        {t.id}
      </text>
    </g>
  );
}

function Arc({ from, to, curve }) {
  const path = curve
    ? `M ${from.x} ${from.y} Q ${curve.x} ${curve.y} ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  return (
    <path
      d={path}
      fill="none"
      stroke={COLOR_ARC}
      strokeWidth={2}
      markerEnd="url(#arrowhead)"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function edgePoint(from, to, r) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: from.x + (dx / len) * r, y: from.y + (dy / len) * r };
}

function buildArcs(places, transitions, placeRadius, bow = { dx: 0, dy: 60 }, extraCurves = {}) {
  const placeById = Object.fromEntries(places.map((p) => [p.id, p]));
  const arcs = [];
  transitions.forEach((t) => {
    Object.keys(t.inputs).forEach((pid) => {
      const p = placeById[pid];
      arcs.push({
        key: `${pid}->${t.id}`,
        from: edgePoint(p, t, placeRadius),
        to: edgePoint(t, p, 22),
        curve: null,
      });
    });
    Object.keys(t.outputs).forEach((pid) => {
      const p = placeById[pid];
      arcs.push({
        key: `${t.id}->${pid}`,
        from: edgePoint(t, p, 22),
        to: edgePoint(p, t, placeRadius),
        curve: null,
      });
    });
  });
  // Courbes dédiées (ex. mobile : MonnaieRendue -> T5 contourne les textes)
  Object.entries(extraCurves).forEach(([key, ctrl]) => {
    const i = arcs.findIndex((a) => a.key === key);
    if (i >= 0) arcs[i] = { ...arcs[i], curve: ctrl };
  });
  // Courbe dédiée pour le retour de ressource (machine qui se libère)
  const idx = arcs.findIndex((a) => a.key === "T3->MachineLibre");
  const t3 = transitions.find((t) => t.id === "T3");
  const machineLibre = placeById.MachineLibre;
  if (idx >= 0) {
    const mid = { x: (t3.x + machineLibre.x) / 2 + bow.dx, y: (t3.y + machineLibre.y) / 2 + bow.dy };
    arcs[idx] = {
      ...arcs[idx],
      from: edgePoint(t3, machineLibre, 22),
      to: edgePoint(machineLibre, t3, placeRadius),
      curve: mid,
    };
  }
  return arcs;
}

const ARCS_DESKTOP = buildArcs(DESKTOP_LAYOUT.places, DESKTOP_LAYOUT.transitions, 38, { dx: 45, dy: 95 });
const ARCS_MOBILE = buildArcs(MOBILE_LAYOUT.places, MOBILE_LAYOUT.transitions, 34, { dx: 115, dy: 58 }, {
  "MonnaieRendue->T5": { x: 290, y: 925 },
});

// Petit bandeau de décision (état DÉRIVÉ, pas une place RDP à part entière) :
// affiche visuellement le résultat de la garde "Vérifier paiement". Ancré
// sur la position de MontantInsere. Utilisé uniquement en mise en page
// bureau : en mobile, l'espace vertical est déjà serré et ce statut est
// affiché en grand, sans ambiguïté, dans le panneau "Paiement" juste
// au-dessous du diagramme — l'ajouter aussi dans le SVG ferait doublon et
// risquerait de chevaucher les autres nœuds sur un tracé aussi compact.
function PaymentBadges({ status, anchor }) {
  const items = [
    { key: "insuffisant", label: "Insuffisant", color: "#f87171", dx: -150 },
    { key: "exact", label: "Exact", color: "#4ade80", dx: 0 },
    { key: "superieur", label: "Supérieur", color: "#38bdf8", dx: 150 },
  ];
  const y = anchor.y - 135; // centre des pastilles
  const lineStart = anchor.y - 38 - 38; // au-dessus du nom MontantInsere
  return (
    <g>
      <line
        x1={anchor.x}
        y1={lineStart}
        x2={anchor.x}
        y2={y + 20}
        stroke={COLOR_ARC}
        strokeWidth={1.8}
        strokeDasharray="4,5"
        markerEnd="url(#arrowhead)"
      />
      <text
        x={anchor.x + 12}
        y={(lineStart + y + 20) / 2 + 5}
        textAnchor="start"
        fontSize="15"
        fill={COLOR_LABEL}
        fontStyle="italic"
        {...TXT_HALO}
      >
        Vérifier paiement
      </text>
      {items.map((it) => {
        const active = status === it.key;
        const x = anchor.x + it.dx;
        return (
          <g key={it.key}>
            <rect
              x={x - 62}
              y={y - 18}
              width={124}
              height={36}
              rx={18}
              fill={active ? `${it.color}33` : "#12151c"}
              stroke={active ? it.color : "#6b7385"}
              strokeWidth={active ? 2.5 : 1.5}
              style={{ transition: "all 300ms ease" }}
            />
            <text
              x={x}
              y={y + 6}
              textAnchor="middle"
              fontSize="17"
              fontWeight="700"
              fill={active ? it.color : "#e5e7eb"}
              fontFamily="'JetBrains Mono', ui-monospace, monospace"
            >
              {it.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// Détecte un écran étroit (mobile) pour basculer vers la mise en page
// verticale du diagramme RDP (voir MOBILE_LAYOUT plus haut), afin d'éviter
// tout scroll horizontal et de garder le texte lisible sans avoir à
// l'écraser via une forte réduction d'échelle.
function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);
  return isMobile;
}

// --- app principale ----------------------------------------------------------

export default function App() {
  const isMobile = useIsMobile();
  const { places: PLACES, transitions: TRANSITIONS } = isMobile ? MOBILE_LAYOUT : DESKTOP_LAYOUT;
  const ARCS = isMobile ? ARCS_MOBILE : ARCS_DESKTOP;
  const [marking, setMarking] = useState(INITIAL_MARKING);
  const [montant, setMontant] = useState(0); // montantInsere (Ar), cumulé, jamais remis à 0 tant que la transaction n'est pas finie
  const [monnaie, setMonnaie] = useState(0); // monnaieARendre (Ar), calculée quand le paiement démarre la préparation
  const [log, setLog] = useState([]);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1000);
  const intervalRef = useRef(null);

  const addClient = () => setMarking((m) => ({ ...m, ClientPret: m.ClientPret + 1 }));

  // Statut dérivé du paiement (garde), recalculé à chaque rendu — jamais
  // stocké comme un marquage indépendant pour éviter toute désynchronisation.
  const paiementActif = marking.MontantInsere > 0;
  const paiementStatus = !paiementActif
    ? null
    : montant < PRIX_BOISSON
    ? "insuffisant"
    : montant === PRIX_BOISSON
    ? "exact"
    : "superieur";

  const canInsert =
    (marking.ClientPret > 0 && marking.MontantInsere === 0) ||
    (marking.MontantInsere > 0 && montant < PRIX_BOISSON);

  // --- T1 : insérer de l'argent (montant paramétrable, boucle si insuffisant) ---
  const insererArgent = useCallback(
    (valeur) => {
      if (!canInsert) return;
      setMarking((m) => {
        if (m.MontantInsere > 0) return m; // transaction déjà démarrée : on ne touche pas au marquage, seul `montant` augmente
        return { ...m, ClientPret: m.ClientPret - 1, MontantInsere: 1 };
      });
      setMontant((v) => v + valeur);
      setStep((s) => s + 1);
      setLog((l) =>
        [
          {
            id: "T1",
            desc: `Le client insère ${valeur.toLocaleString("fr-FR")} Ar (montant cumulé)`,
            n: l.length + 1,
          },
          ...l,
        ].slice(0, 8)
      );
    },
    [canInsert]
  );

  const annulerPaiement = useCallback(() => {
    if (marking.MontantInsere <= 0 || marking.EnPreparation > 0) return;
    setMarking((m) => ({ ...m, MontantInsere: 0, ClientPret: m.ClientPret + 1 }));
    setMontant(0);
    setMonnaie(0);
    setStep((s) => s + 1);
    setLog((l) => [{ id: "—", desc: "Paiement annulé par le client, montant remis à zéro", n: l.length + 1 }, ...l].slice(0, 8));
  }, [marking]);

  // --- Statut d'activation de chaque transition (garde) -----------------------
  const enabledFor = useCallback(
    (tid) => {
      switch (tid) {
        case "T1":
          return canInsert;
        case "T2":
          return marking.MontantInsere > 0 && montant >= PRIX_BOISSON && marking.MachineLibre > 0;
        case "T3":
          return isEnabled(TRANSITIONS.find((t) => t.id === "T3"), marking);
        case "T4":
          return marking.BoissonPrete > 0;
        case "T5":
          return marking.Servie > 0 && (monnaie === 0 || marking.MonnaieRendue > 0);
        default:
          return false;
      }
    },
    [marking, montant, monnaie, canInsert]
  );

  // --- Franchissement effectif de chaque transition ---------------------------
  const doFire = useCallback(
    (tid) => {
      if (!enabledFor(tid)) return;

      if (tid === "T1") {
        insererArgent(500); // clic direct sur le nœud du diagramme = pièce par défaut
        return;
      }

      if (tid === "T2") {
        const rendu = montant - PRIX_BOISSON;
        setMonnaie(rendu);
        setMarking((m) => ({ ...m, MontantInsere: 0, MachineLibre: 0, EnPreparation: 1 }));
        setStep((s) => s + 1);
        setLog((l) =>
          [
            {
              id: "T2",
              desc:
                rendu > 0
                  ? `Paiement supérieur (${montant.toLocaleString("fr-FR")} Ar) : préparation démarrée, ${rendu.toLocaleString(
                      "fr-FR"
                    )} Ar à rendre`
                  : `Paiement exact (${montant.toLocaleString("fr-FR")} Ar) : préparation démarrée`,
              n: l.length + 1,
            },
            ...l,
          ].slice(0, 8)
        );
        // La transaction de CE client quitte la place MontantInsere (jeton
        // consommé par T2) : le compteur `montant` affiché au panneau
        // Paiement doit donc revenir à 0 immédiatement, exactement comme le
        // marquage RDP (MontantInsere passe à 0). Sinon l'ancien montant
        // resterait affiché et empêcherait de voir clairement l'argent
        // inséré par le client SUIVANT. La monnaie à rendre de ce client est
        // déjà sauvegardée à part dans `monnaie` (utilisée par T4/T5), donc
        // aucune donnée n'est perdue.
        setMontant(0);
        return;
      }

      if (tid === "T3") {
        setMarking((m) => fireTransition(TRANSITIONS.find((t) => t.id === "T3"), m));
        setStep((s) => s + 1);
        setLog((l) => [{ id: "T3", desc: "Fanta Orange prête, la machine se libère", n: l.length + 1 }, ...l].slice(0, 8));
        return;
      }

      if (tid === "T4") {
        setMarking((m) => ({
          ...m,
          BoissonPrete: 0,
          Servie: 1,
          MonnaieRendue: monnaie > 0 ? 1 : 0,
        }));
        setStep((s) => s + 1);
        setLog((l) =>
          [
            {
              id: "T4",
              desc:
                monnaie > 0
                  ? `Fork — Fanta Orange servi ET ${monnaie.toLocaleString("fr-FR")} Ar de monnaie rendue`
                  : "Fork — Fanta Orange servi (aucune monnaie à rendre)",
              n: l.length + 1,
            },
            ...l,
          ].slice(0, 8)
        );
        return;
      }

      if (tid === "T5") {
        setMarking((m) => ({
          ...m,
          Servie: 0,
          MonnaieRendue: 0,
          ClientsServis: m.ClientsServis + 1,
          ClientPret: m.ClientPret + 1, // la machine peut accepter un nouveau client
        }));
        setStep((s) => s + 1);
        setLog((l) => [{ id: "T5", desc: "Join — le client repart, transaction clôturée", n: l.length + 1 }, ...l].slice(0, 8));
        setMontant(0);
        setMonnaie(0);
        return;
      }
    },
    [enabledFor, montant, monnaie, insererArgent]
  );

  // --- lecture automatique -----------------------------------------------------
  useEffect(() => {
    if (!playing) {
      clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      const candidates = ["T1", "T2", "T3", "T4", "T5"].filter((tid) => enabledFor(tid));
      if (candidates.length === 0) return;
      // en lecture auto, on privilégie l'avancement du paiement (T1) tant qu'il est insuffisant
      const chosen =
        candidates.includes("T1") && paiementStatus === "insuffisant"
          ? "T1"
          : candidates[Math.floor(Math.random() * candidates.length)];
      if (chosen === "T1") {
        const reste = Math.max(PRIX_BOISSON - montant, 500);
        const piece = DENOMINATIONS.find((d) => d >= reste) || DENOMINATIONS[DENOMINATIONS.length - 1];
        insererArgent(piece);
      } else {
        doFire(chosen);
      }
    }, speed);
    return () => clearInterval(intervalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, enabledFor, paiementStatus, montant]);

  const reset = () => {
    setPlaying(false);
    setMarking(INITIAL_MARKING);
    setMontant(0);
    setMonnaie(0);
    setLog([]);
    setStep(0);
  };

  const machineBusy = marking.EnPreparation > 0;
  const manque = Math.max(PRIX_BOISSON - montant, 0);

  return (
    <div className="relative min-h-screen w-full bg-[#0a0b0f] text-neutral-200 font-sans overflow-x-hidden">
      {/* décor : halos de couleur en arrière-plan, effet "moderne" */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-24 w-[420px] h-[420px] bg-amber-500/10 rounded-full blur-[120px]" />
        <div className="absolute top-1/3 -right-32 w-[480px] h-[480px] bg-purple-500/10 rounded-full blur-[130px]" />
        <div className="absolute bottom-0 left-1/3 w-[380px] h-[380px] bg-sky-500/10 rounded-full blur-[120px]" />
      </div>

      <div className="relative max-w-[1400px] mx-auto px-4 sm:px-6 py-6 sm:py-10">
        {/* header */}
        <div className="mb-7 sm:mb-9 animate-fade-in">
          <div className="inline-flex items-center gap-2 text-amber-200 text-sm font-mono tracking-wide mb-3 bg-amber-500/15 border border-amber-400/40 rounded-full px-3.5 py-1.5">
            <Sparkles size={13} /> Réseaux de Pétri — 5 transitions
          </div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-white tracking-tight">
            Distributeur automatique de boissons{" "}
            <span className="text-orange-300">
              — Fanta Orange
            </span>
          </h1>
          <p className="text-neutral-200 text-base mt-3 max-w-4xl leading-relaxed">
            La machine ne prépare ici qu'une seule référence, <b className="text-orange-300">Fanta Orange</b>,
            pour simplifier le scénario. Le client peut insérer son argent en plusieurs fois — le{" "}
            <b className="text-white">montant est toujours cumulé</b>, jamais perdu. Une garde
            compare le montant au prix ({PRIX_BOISSON.toLocaleString("fr-FR")} Ar) : paiement{" "}
            <b className="text-red-300">insuffisant</b> (on rebroucle sur l'insertion),{" "}
            <b className="text-emerald-300">exact</b>, ou <b className="text-sky-300">supérieur</b> (la
            monnaie sera rendue en parallèle du service, à la façon d'un{" "}
            <span className="text-amber-400 font-medium">fork</span> conditionnel en{" "}
            <span className="text-amber-400 font-medium">T4</span>, puis d'un{" "}
            <span className="text-amber-400 font-medium">join</span> conditionnel en{" "}
            <span className="text-amber-400 font-medium">T5</span>).
          </p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_390px] gap-5 items-start">
          {/* diagramme RDP */}
          <div
            className={`bg-white/[0.03] backdrop-blur-xl border border-white/[0.07] rounded-3xl p-4 sm:p-6 shadow-2xl shadow-black/40 ${
              ""
            }`}
          >
            {/* Mobile : mise en page verticale en une colonne, affichée à
               une échelle proche du 1:1 -> le diagramme entier tient dans la
               largeur de l'écran, sans scrollbar horizontale ni verticale
               propre au cadre (seul le défilement normal de la page peut
               s'appliquer, comme pour n'importe quel contenu qui dépasse la
               hauteur visible).
               Bureau : mise en page horizontale d'origine, avec défilement
               horizontal si la fenêtre est plus étroite que le diagramme. */}
            <svg
              viewBox={isMobile ? "0 0 330 1060" : "-10 0 1050 500"}
              className={"w-full h-auto"}
              style={{ textRendering: "optimizeLegibility", shapeRendering: "geometricPrecision" }}
            >
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 Z" fill="#8b94a7" />
                </marker>
              </defs>
              {ARCS.map((a) => (
                <Arc key={a.key} from={a.from} to={a.to} curve={a.curve} />
              ))}
              {!isMobile && (
                <PaymentBadges status={paiementStatus} anchor={PLACE_COORDS_DESKTOP.MontantInsere} />
              )}
              {TRANSITIONS.map((t) => (
                <TransitionNode key={t.id} t={t} enabled={enabledFor(t.id)} onFire={doFire} mobile={isMobile} />
              ))}
              {PLACES.map((p) => (
                <PlaceNode key={p.id} place={p} tokens={marking[p.id]} mobile={isMobile} />
              ))}
            </svg>

            <div className="flex flex-wrap gap-2 mt-5">
              <button
                onClick={addClient}
                className="group flex items-center gap-2 text-sm font-mono font-semibold px-4 py-2.5 rounded-xl border bg-blue-500/15 border-blue-400/50 text-blue-200 hover:bg-blue-500/25 hover:border-blue-400/70 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200"
              >
                <Plus size={15} className="group-hover:rotate-90 transition-transform duration-300" />
                Nouveau client
              </button>
              {TRANSITIONS.filter((t) => t.id !== "T1").map((t) => {
                const en = enabledFor(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => doFire(t.id)}
                    disabled={!en}
                    className={`text-sm font-mono font-semibold px-4 py-2.5 rounded-xl border transition-all duration-200 ${
                      en
                        ? "bg-amber-500/15 border-amber-400/60 text-amber-200 hover:bg-amber-500/25 hover:-translate-y-0.5 active:translate-y-0"
                        : "bg-white/[0.04] border-white/[0.12] text-neutral-400 cursor-not-allowed"
                    }`}
                    title={t.desc}
                  >
                    Franchir {t.id}
                  </button>
                );
              })}
              <span className="text-sm px-2 py-2.5 text-neutral-300">
                (T1 se pilote depuis le panneau Paiement ci-contre)
              </span>
            </div>
          </div>

          {/* panneau de contrôle */}
          <div className="flex flex-col gap-4">
            {/* NOUVEAU — panneau de paiement */}
            <div className="bg-white/[0.03] backdrop-blur-xl border border-white/[0.07] rounded-3xl p-5 shadow-2xl shadow-black/40">
              <div className="flex items-center gap-2 text-sm font-mono font-semibold tracking-wide text-neutral-100 mb-4">
                <Wallet size={16} /> Paiement
              </div>

              <div className="space-y-2 text-base font-mono mb-4">
                <div className="flex justify-between text-neutral-200">
                  <span>Prix</span>
                  <span className="text-white font-semibold">{PRIX_BOISSON.toLocaleString("fr-FR")} Ar</span>
                </div>
                <div className="flex justify-between text-neutral-200">
                  <span>Montant inséré</span>
                  <span key={montant} className="text-blue-300 font-bold animate-pop">
                    {montant.toLocaleString("fr-FR")} Ar
                  </span>
                </div>
                {paiementStatus === "insuffisant" && (
                  <div className="flex justify-between text-red-300">
                    <span>Il manque</span>
                    <span className="font-semibold">{manque.toLocaleString("fr-FR")} Ar</span>
                  </div>
                )}
                {paiementStatus === "superieur" && (
                  <div className="flex justify-between text-sky-300">
                    <span>Monnaie à rendre</span>
                    <span className="font-semibold">{(montant - PRIX_BOISSON).toLocaleString("fr-FR")} Ar</span>
                  </div>
                )}
              </div>

              <div
                className={`flex items-center gap-2 text-sm font-semibold rounded-lg px-3 py-2.5 mb-4 ${
                  paiementStatus === "insuffisant"
                    ? "bg-red-500/15 text-red-200 border border-red-400/50"
                    : paiementStatus === "exact"
                    ? "bg-emerald-500/15 text-emerald-200 border border-emerald-400/50"
                    : paiementStatus === "superieur"
                    ? "bg-sky-500/15 text-sky-200 border border-sky-400/50"
                    : "bg-white/[0.05] text-neutral-200 border border-white/[0.15]"
                }`}
              >
                {paiementStatus === "insuffisant" && (
                  <>
                    <XCircle size={17} /> Paiement insuffisant
                  </>
                )}
                {paiementStatus === "exact" && (
                  <>
                    <CheckCircle2 size={17} /> Paiement exact
                  </>
                )}
                {paiementStatus === "superieur" && (
                  <>
                    <CheckCircle2 size={17} /> Paiement accepté
                  </>
                )}
                {paiementStatus === null && <>En attente d'un client…</>}
              </div>

              <div className="grid grid-cols-3 gap-1.5 mb-2">
                {DENOMINATIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => insererArgent(d)}
                    disabled={!canInsert}
                    className={`flex items-center justify-center gap-1 text-sm font-mono font-semibold px-1.5 py-2.5 rounded-lg border transition-all duration-200 ${
                      canInsert
                        ? "bg-blue-500/15 border-blue-400/50 text-blue-100 hover:bg-blue-500/25 hover:-translate-y-0.5 active:translate-y-0"
                        : "bg-white/[0.04] border-white/[0.12] text-neutral-400 cursor-not-allowed"
                    }`}
                  >
                    <Banknote size={14} /> +{d.toLocaleString("fr-FR")}
                  </button>
                ))}
                <button
                  onClick={annulerPaiement}
                  disabled={marking.MontantInsere <= 0 || marking.EnPreparation > 0}
                  className={`flex items-center justify-center gap-1 text-sm font-mono font-semibold px-1.5 py-2.5 rounded-lg border transition-all duration-200 ${
                    marking.MontantInsere > 0 && marking.EnPreparation === 0
                      ? "bg-red-500/15 border-red-400/50 text-red-200 hover:bg-red-500/25"
                      : "bg-white/[0.04] border-white/[0.12] text-neutral-400 cursor-not-allowed"
                  }`}
                >
                  <X size={14} /> Annuler
                </button>
              </div>
            </div>

            {/* vue machine */}
            <div className="bg-white/[0.03] backdrop-blur-xl border border-white/[0.07] rounded-3xl p-5 shadow-2xl shadow-black/40">
              <div className="flex items-center justify-between mb-4">
                <div className="text-sm font-mono font-semibold tracking-wide text-neutral-100">
                  Vue de la machine
                </div>
                <div className="text-xs font-mono font-semibold text-orange-200 bg-orange-500/15 border border-orange-400/50 rounded-full px-2.5 py-1">
                  Fanta Orange
                </div>
              </div>
              <div className="flex items-center justify-around">
                <div className="flex flex-col items-center gap-2">
                  <div
                    className={`w-16 h-16 rounded-2xl flex items-center justify-center border transition-all duration-500 ${
                      machineBusy
                        ? "bg-orange-500/15 border-orange-500/40"
                        : "bg-emerald-500/10 border-emerald-500/25"
                    }`}
                  >
                    <CupSoda
                      size={26}
                      className={machineBusy ? "text-orange-400 animate-pulse" : "text-emerald-300"}
                    />
                  </div>
                  <span className="text-sm font-mono text-neutral-100 text-center">
                    {machineBusy ? "Fanta Orange en préparation…" : "Machine libre"}
                  </span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center border bg-sky-500/10 border-sky-500/25">
                    <UserCheck size={24} className="text-sky-400" />
                  </div>
                  <span className="text-sm font-mono text-neutral-100 text-center">
                    {marking.ClientsServis} servis
                  </span>
                </div>
              </div>
              {machineBusy && (
                <div className="mt-4 h-1.5 w-full bg-white/[0.06] rounded-full overflow-hidden">
                  <div className="h-full w-1/3 bg-gradient-to-r from-amber-500 to-amber-300 rounded-full animate-[loading_1.1s_ease-in-out_infinite]" />
                </div>
              )}
            </div>

            {/* commandes */}
            <div className="bg-white/[0.03] backdrop-blur-xl border border-white/[0.07] rounded-3xl p-5 shadow-2xl shadow-black/40">
              <div className="text-sm font-mono font-semibold tracking-wide text-neutral-100 mb-4">
                Simulation
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPlaying((p) => !p)}
                  className="flex-1 flex items-center justify-center gap-2 text-sm font-semibold px-3 py-2.5 rounded-xl bg-gradient-to-br from-amber-400 to-amber-500 text-neutral-900 hover:from-amber-300 hover:to-amber-400 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200 shadow-lg shadow-amber-500/20"
                >
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                  {playing ? "Pause" : "Lecture auto"}
                </button>
                <button
                  onClick={reset}
                  aria-label="Réinitialiser"
                  title="Réinitialiser"
                  className="flex items-center justify-center gap-2 text-sm px-3.5 py-2.5 rounded-xl bg-white/[0.07] border border-white/[0.18] text-neutral-100 hover:bg-white/[0.09] hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200"
                >
                  <RotateCcw size={15} />
                  <span className="sr-only">Réinitialiser</span>
                </button>
              </div>
              <div className="mt-4">
                <label className="text-sm text-neutral-200 flex justify-between mb-2">
                  <span>Vitesse</span>
                  <span className="font-mono text-neutral-100">{(speed / 1000).toFixed(1)}s</span>
                </label>
                <input
                  type="range"
                  min="400"
                  max="2000"
                  step="100"
                  value={2400 - speed}
                  onChange={(e) => setSpeed(2400 - Number(e.target.value))}
                  className="w-full accent-amber-500"
                />
              </div>
              <div className="mt-3 text-sm text-neutral-200 font-mono">Étape n° {step}</div>
            </div>

            {/* marquage */}
            <div className="bg-white/[0.03] backdrop-blur-xl border border-white/[0.07] rounded-3xl p-5 shadow-2xl shadow-black/40">
              <div className="text-sm font-mono font-semibold tracking-wide text-neutral-100 mb-4">
                Marquage M
              </div>
              <div className="grid grid-cols-3 gap-2">
                {PLACES.map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-col items-center gap-1 bg-white/[0.03] rounded-xl py-2.5 border border-white/[0.06] transition-all duration-300 hover:bg-white/[0.06]"
                  >
                    <span className="text-[11px] font-mono text-neutral-200 text-center px-0.5 leading-tight">
                      {p.id}
                    </span>
                    <span
                      key={marking[p.id]}
                      className="text-lg font-mono font-bold animate-pop"
                      style={{ color: marking[p.id] ? p.color : "#9ca3af" }}
                    >
                      {marking[p.id]}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-sm text-neutral-200 mt-4 leading-relaxed flex gap-2">
                <Info size={16} className="shrink-0 mt-0.5" />
                <span>Invariant : M(MachineLibre) + M(EnPreparation) = 1 (exclusion mutuelle).</span>
              </p>
            </div>

            {/* journal */}
            <div className="bg-white/[0.03] backdrop-blur-xl border border-white/[0.07] rounded-3xl p-5 shadow-2xl shadow-black/40">
              <div className="text-sm font-mono font-semibold tracking-wide text-neutral-100 mb-4">
                Historique
              </div>
              {log.length === 0 ? (
                <p className="text-sm text-neutral-300">Aucun événement pour l'instant.</p>
              ) : (
                <ul className="space-y-2 max-h-56 overflow-y-auto pr-1 thin-scroll">
                  {log.map((entry) => (
                    <li key={entry.n} className="text-sm flex gap-2 text-neutral-200 animate-fade-in">
                      <span className="font-mono font-semibold text-amber-300 shrink-0">
                        #{entry.n} {entry.id}
                      </span>
                      <span className="text-neutral-200">{entry.desc}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="mt-7 flex items-start gap-2 text-sm text-neutral-300">
          <Coins size={16} className="shrink-0 mt-0.5" />
          <span>
            Modèle : RDP à 8 places / 5 transitions avec ressource partagée, fork/join conditionnels
            (T4/T5) et gardes de paiement (T1/T2) — mêmes principes que le cours, appliqués à un scénario
            différent.
          </span>
        </div>
      </div>

      <style>{`
        @keyframes loading {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  );
}
