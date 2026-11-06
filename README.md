# RDP — Distributeur automatique de boissons (React + Tailwind)

Simulateur interactif d'un Réseau de Pétri à **5 transitions**, avec une
interface moderne (glassmorphism, halos de couleur, micro-animations) et
entièrement responsive. Le scénario modélise un distributeur de boissons
avec une **gestion réaliste du paiement progressif** : le client peut
insérer plusieurs pièces/billets, le montant est toujours cumulé, et la
machine distingue automatiquement paiement insuffisant / exact / supérieur
(avec rendu de monnaie).

## Modèle RDP

- **Places (8)** : `ClientPret`, `MontantInsere`, `MachineLibre`,
  `EnPreparation`, `BoissonPrete`, `Servie`, `MonnaieRendue`,
  `ClientsServis`
- **Transitions (5)** :
  - `T1` — Insérer de l'argent (`ClientPret` → `MontantInsere`, puis chaque
    pièce/billet supplémentaire boucle sur `MontantInsere` tant que le
    paiement est insuffisant — le montant n'est **jamais** remis à zéro
    avant la fin ou l'annulation de la transaction)
  - `T2` — Démarrer la préparation, **gardée par** `montant >= 3000 Ar`
    (`MontantInsere` + `MachineLibre` → `EnPreparation`)
  - `T3` — Préparation terminée (`EnPreparation` → `BoissonPrete` +
    `MachineLibre`)
  - `T4` — **Fork conditionnel** : sert la boisson, et rend la monnaie
    uniquement si elle est due (`BoissonPrete` → `Servie` [+
    `MonnaieRendue`])
  - `T5` — **Join conditionnel** : le client repart — n'exige
    `MonnaieRendue` que si une monnaie était due, donc ne bloque jamais un
    paiement exact (`Servie` [+ `MonnaieRendue`] → `ClientsServis`), puis
    réinitialise `montant`/`monnaie` et réarme `ClientPret` pour le client
    suivant
- **Invariant** : `M(MachineLibre) + M(EnPreparation) = 1` (exclusion
  mutuelle sur la machine).

### Gestion du paiement

Un jeton RDP classique (0/1) ne porte pas de valeur numérique. Le montant
réel (`montantInsere`, `monnaieARendre`) est donc suivi dans un état
parallèle au marquage, et sert de **garde** qui décide si `T1`/`T2`/`T4`/`T5`
sont franchissables — exactement le principe d'un RDP coloré (le jeton
« porte » une valeur). Le diagramme affiche un petit bandeau dérivé
(Insuffisant / Exact / Supérieur) qui matérialise cette garde sans casser la
structure mathématique du réseau (places = jetons entiers, transitions =
franchissement local).

- Prix de la boisson : `PRIX_BOISSON = 3000` (Ar), modifiable en haut de
  `src/App.jsx`.
- Boutons de paiement : `+500`, `+1 000`, `+2 000`, `+5 000`, `+10 000` Ar.
- Bouton **Annuler** : disponible tant que la préparation n'a pas démarré ;
  remet `montantInsere`/`monnaieARendre` à zéro et redonne un jeton
  `ClientPret`.
- Scénarios testés : 3000/3000 (exact), 2000+500+500 (exact, cumulé),
  2000+500+1000 (supérieur, monnaie 500), 5000 direct (monnaie 2000), 10000
  direct (monnaie 7000) — tous vérifiés.

## Installation (terminal VSCode)

Ouvrir un terminal dans VSCode (`Terminal > New Terminal`), se placer dans le
dossier du projet, puis :

```bash
npm install
npm run dev
```

Ouvrir ensuite l'URL affichée dans le terminal (en général
`http://localhost:5173`).

## Autres commandes utiles

```bash
npm run build     # génère une version de production dans dist/
npm run preview   # prévisualise la version de production
```

## Structure du projet

```
distributeur-boissons-rdp/
├── index.html
├── package.json
├── postcss.config.js
├── tailwind.config.js       # polices Inter / JetBrains Mono + animations
├── vite.config.js
└── src/
    ├── App.jsx      # logique et diagramme du Réseau de Pétri
    ├── main.jsx      # point d'entrée React
    └── index.css     # styles de base + scrollbar personnalisée
```


`T4`/`T5` illustrent un pattern de **parallélisme** (fork/join), complément
naturel du conflit (choix) et de l'exclusion mutuelle déjà vus dans les
autres scénarios.
# rdp-projet-M1

## Lisibilité (mise à jour)

- Textes du diagramme agrandis (polices ≥ 12 px réels, y compris une fois le
  SVG réduit à l'écran), contrastes renforcés (blanc/gris clair sur fond sombre).
- Étiquettes T1…T5 et noms de places repositionnés pour qu'aucune flèche ne les
  traverse (bureau et mobile) ; contour sombre autour des textes SVG.
- Panneaux latéraux : texte ≥ 14 px, boutons désactivés lisibles, montants
  affichés en toutes lettres (« +1 000 » au lieu de « +1k »).
