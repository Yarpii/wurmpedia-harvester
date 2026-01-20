# Wurmpedia Harvester v2.0

Een robuuste harvester voor alle Wurmpedia pagina's inclusief crafting & cooking recepten.
Ontworpen voor 5600+ pagina's met incrementele opslag en crash recovery.

## Features

- 📦 **Incrementele opslag** - Slaat elke pagina apart op, geen geheugen-bloat
- 🔄 **Checkpoint systeem** - Hervat waar je was na een crash of onderbreking
- ⏱️ **Rate limiting** - Respecteert de wiki server met exponential backoff
- 🍳 **Recept extractie** - Herkent cooking, crafting en alchemy recepten
- 📊 **Progress tracking** - Real-time voortgang met ETA
- 📁 **Multi-format export** - JSON bestanden voor verschillende doeleinden

## Installatie

```bash
# Clone of download dit project
cd wurmpedia-harvester

# Geen dependencies nodig! Gebruikt alleen Node.js built-ins
node --version  # Moet 18+ zijn
```

## Gebruik

### Volledige harvest (aanbevolen eerste keer)

```bash
node harvest-wurmpedia.js harvest
# of
npm run harvest
```

Dit draait alle drie fasen:
1. **Pages** - Haalt alle pagina titels en categorieën op (~15 min)
2. **Content** - Download wikitext voor elke pagina (~2 uur)
3. **Recipes** - Extraheert recepten uit de content (~5 min)

### Individuele commando's

```bash
# Alleen pagina lijst ophalen
node harvest-wurmpedia.js pages

# Alleen content downloaden (voor pagina's zonder content)
node harvest-wurmpedia.js content

# Alleen recepten extraheren uit bestaande content
node harvest-wurmpedia.js recipes

# Hervat onderbroken harvest
node harvest-wurmpedia.js resume

# Toon statistieken
node harvest-wurmpedia.js stats

# Exporteer naar JSON bestanden
node harvest-wurmpedia.js export

# Reset checkpoint (begin opnieuw)
node harvest-wurmpedia.js clear
```

## Output Structuur

```
data/
├── index.json              # Hoofd-index met alle pagina's
├── meta.json               # Metadata (laatste harvest, versie)
├── checkpoint.json         # Voortgang voor resume
│
├── pages/                  # Pagina metadata per ID
│   └── {pageid}.json
│
├── content/                # Wikitext content per pagina
│   └── {pageid}.json       # {pageid, title, wikitext, categories}
│
├── recipes/                # Geëxtraheerde recepten
│   └── {pageid}.json       # Alleen voor pagina's met recepten
│
└── export/                 # Finale exports (na `npm run export`)
    ├── pages.json          # Alle pagina's
    ├── recipes.json        # Alle recepten
    ├── cooking-recipes.json
    ├── crafting-recipes.json
    ├── categories.json
    └── recipes-high-confidence.json
```

## Recept Formaat

```json
{
  "pageid": 12345,
  "title": "Iron Hammer",
  "type": "crafting",
  "categories": ["Tools", "Smithing"],
  "extracted": {
    "skills": ["Blacksmithing"],
    "ingredients": [
      { "quantity": 1, "item": "iron lump" },
      { "quantity": 1, "item": "shaft" }
    ],
    "tools": ["hammer", "anvil"],
    "containers": [],
    "output": ["Iron Hammer"],
    "difficulty": 20,
    "time": null
  },
  "crafting": {
    "activate": "iron lump",
    "target": "anvil",
    "action": "create",
    "materials": [
      { "quantity": 0.5, "material": "iron" }
    ]
  },
  "confidence": 0.7
}
```

### Cooking Recept Voorbeeld

```json
{
  "pageid": 67890,
  "title": "Meat Stew",
  "type": "cooking",
  "categories": ["Cooking", "Hot food cooking"],
  "extracted": {
    "skills": ["Hot food cooking"],
    "ingredients": [
      { "quantity": 1, "item": "meat" },
      { "quantity": 1, "item": "potato" },
      { "quantity": 1, "item": "water" }
    ],
    "tools": [],
    "containers": ["pottery bowl"],
    "output": ["Meat Stew"]
  },
  "cooking": {
    "cooker": "oven",
    "container": "pottery bowl",
    "mandatory": ["any meat"],
    "optional": ["salt", "any herb"],
    "oneOrMore": ["any vegetable"]
  },
  "confidence": 0.85
}
```

## Confidence Score

Elke recept krijgt een confidence score (0.0 - 1.0) gebaseerd op:

| Factor | Punten |
|--------|--------|
| Skills gevonden | +2 |
| Ingrediënten gevonden | +2 |
| >3 ingrediënten | +1 |
| Tools gevonden | +1 |
| Containers gevonden | +1 |
| Cooking data (mandatory/container) | +2 |
| Crafting data (activate/materials) | +2 |
| Relevante categorieën | +1 |

Score = punten / 10

- **< 0.2** - Niet als recept opgeslagen
- **0.2 - 0.5** - Mogelijk recept, check handmatig
- **≥ 0.5** - Waarschijnlijk een echt recept

## Troubleshooting

### "fetch failed" errors

De harvester heeft een agressieve retry strategie:
- 5 pogingen per request
- Exponential backoff (2s → 4s → 8s → 16s → 30s max)
- Bij 429 (rate limit) wordt automatisch langer gewacht

Als je consistent errors krijgt, verhoog `RATE_LIMIT_MS` in de config:

```javascript
const CONFIG = {
  RATE_LIMIT_MS: 2000,  // Verhoog naar 2500 of 3000
  // ...
};
```

### Harvest onderbroken?

Geen probleem! Run gewoon:

```bash
node harvest-wurmpedia.js resume
```

Het checkpoint systeem onthoudt exact waar je was.

### Wil je opnieuw beginnen?

```bash
node harvest-wurmpedia.js clear
rm -rf data/
node harvest-wurmpedia.js harvest
```

## API Rate Limits

De harvester respecteert Wurmpedia met:
- 1.5 seconden tussen requests
- Batches van 50 pagina's voor categorieën
- Exponential backoff bij errors

**Totale geschatte tijd**: ~2.5 uur voor 5600 pagina's

## Gebruik met jouw project

Na de harvest kun je de JSON exports gebruiken in je eigen applicatie:

```javascript
const fs = require('fs');

// Laad alle recepten
const recipes = JSON.parse(
  fs.readFileSync('data/export/recipes.json', 'utf-8')
);

// Filter cooking recepten met hoge confidence
const reliableCooking = recipes.filter(r => 
  r.type === 'cooking' && r.confidence >= 0.5
);

console.log(`Found ${reliableCooking.length} reliable cooking recipes`);
```

## License

MIT - Vrij te gebruiken en aan te passen.

---

Gemaakt voor het Wurm community project 🔨
