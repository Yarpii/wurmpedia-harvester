#!/usr/bin/env node

/**
 * ============================================================================
 * Wurmpedia Complete Harvester v2.1
 * ============================================================================
 * 
 * CHANGELOG v2.1:
 * - Fixed: Stats no longer double-count on resume (withContent/withRecipes)
 * - Fixed: Category deduplication in saveBatch() for better performance
 * - Fixed: Progress counter now counts actual saved pages, not batch size
 * - Removed: CONCURRENT_REQUESTS (was unused, sequential is fine for wiki)
 * - Improved: hasRecipeContent() now detects templates ({{Creation, {{Cooking}})
 * - Added: extractCreationTemplate() for structured template parsing
 * - Added: extractItemTemplate() for item infoboxes
 * - Improved: Confidence scoring includes template data
 * - Added: recalcStats() to fix stats after resume
 * 
 * Run: node harvest-wurmpedia-v2.1.js [command]
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  API_BASE: "https://wurmpedia.com/api.php",
  DATA_DIR: path.join(__dirname, "data"),
  CHECKPOINT_FILE: path.join(__dirname, "data", "checkpoint.json"),
  
  // Rate limiting (sequential, no concurrency needed for wiki)
  RATE_LIMIT_MS: 1500,
  BATCH_SIZE: 50,
  
  // Retry logic
  MAX_RETRIES: 5,
  RETRY_BASE_DELAY_MS: 2000,
  RETRY_MAX_DELAY_MS: 30000,
  
  // Recipe detection - these are soft indicators
  RECIPE_INDICATORS: [
    "Recipe", "Ingredients", "Materials", "Required", "Creates", "Output",
    "Skill required", "Tool required", "Container", "Cooker"
  ]
};

// Ensure data directory exists
if (!fs.existsSync(CONFIG.DATA_DIR)) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}

// ============================================================================
// FILE-BASED DATABASE
// ============================================================================

class SimpleDB {
  constructor(dbDir) {
    this.dbDir = dbDir;
    this.pagesDir = path.join(dbDir, "pages");
    this.contentDir = path.join(dbDir, "content");
    this.recipesDir = path.join(dbDir, "recipes");
    this.indexFile = path.join(dbDir, "index.json");
    this.metaFile = path.join(dbDir, "meta.json");
    
    // Ensure directories exist
    [this.pagesDir, this.contentDir, this.recipesDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
    
    // Load or create index
    this.index = this.loadJSON(this.indexFile, { 
      pages: {},           // pageid -> {title, ns, categories, hasContent, hasRecipe}
      byTitle: {},         // title -> pageid
      byCategory: {},      // category -> [pageids] (deduped on save)
      stats: { total: 0, withContent: 0, withRecipes: 0 }
    });
    
    this.meta = this.loadJSON(this.metaFile, {
      lastHarvest: null,
      lastContentFetch: null,
      version: "2.1"
    });
  }
  
  loadJSON(file, defaultValue) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
      }
    } catch (e) {
      console.error(`Warning: Could not load ${file}: ${e.message}`);
    }
    return defaultValue;
  }
  
  saveIndex() {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2));
  }
  
  saveMeta() {
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2));
  }
  
  // Page operations
  addPage(pageid, title, ns, categories = []) {
    const existing = this.index.pages[pageid];
    this.index.pages[pageid] = {
      title,
      ns,
      categories,
      hasContent: existing?.hasContent || false,
      hasRecipe: existing?.hasRecipe || false,
      updatedAt: new Date().toISOString()
    };
    this.index.byTitle[title] = pageid;
    
    // Update category index (allow duplicates, dedupe on saveBatch)
    for (const cat of categories) {
      if (!this.index.byCategory[cat]) {
        this.index.byCategory[cat] = [];
      }
      // Just push, don't check includes() - O(1) instead of O(n)
      this.index.byCategory[cat].push(pageid);
    }
    
    this.index.stats.total = Object.keys(this.index.pages).length;
  }
  
  getPage(pageid) {
    return this.index.pages[pageid];
  }
  
  getPageByTitle(title) {
    const pageid = this.index.byTitle[title];
    return pageid ? { pageid, ...this.index.pages[pageid] } : null;
  }
  
  getAllPageIds() {
    return Object.keys(this.index.pages).map(Number);
  }
  
  getPagesWithoutContent() {
    return Object.entries(this.index.pages)
      .filter(([_, p]) => {
        // Skip if already has content
        if (p.hasContent) return false;
        // Include main namespace (0) and undefined (backwards compat)
        // Note: allpages API with apnamespace=0 should only return ns=0
        return p.ns === 0 || p.ns === undefined;
      })
      .map(([id, _]) => Number(id));
  }
  
  // Debug helper
  getNamespaceDistribution() {
    const dist = {};
    for (const page of Object.values(this.index.pages)) {
      const ns = page.ns ?? 'undefined';
      dist[ns] = (dist[ns] || 0) + 1;
    }
    return dist;
  }
  
  getPagesWithContent() {
    return Object.entries(this.index.pages)
      .filter(([_, p]) => p.hasContent)
      .map(([id, _]) => Number(id));
  }
  
  // FIX: Only increment stats if transitioning from false to true
  saveContent(pageid, content) {
    const file = path.join(this.contentDir, `${pageid}.json`);
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
    
    const page = this.index.pages[pageid];
    if (page) {
      if (!page.hasContent) {
        // Only increment if this is the first time
        this.index.stats.withContent++;
      }
      page.hasContent = true;
    }
  }
  
  getContent(pageid) {
    const file = path.join(this.contentDir, `${pageid}.json`);
    return this.loadJSON(file, null);
  }
  
  // FIX: Only increment stats if transitioning from false to true
  saveRecipe(pageid, recipe) {
    const file = path.join(this.recipesDir, `${pageid}.json`);
    fs.writeFileSync(file, JSON.stringify(recipe, null, 2));
    
    const page = this.index.pages[pageid];
    if (page) {
      if (!page.hasRecipe) {
        // Only increment if this is the first time
        this.index.stats.withRecipes++;
      }
      page.hasRecipe = true;
    }
  }
  
  getRecipe(pageid) {
    const file = path.join(this.recipesDir, `${pageid}.json`);
    return this.loadJSON(file, null);
  }
  
  getAllRecipes() {
    const recipes = [];
    const files = fs.readdirSync(this.recipesDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const recipe = this.loadJSON(path.join(this.recipesDir, file), null);
        if (recipe) recipes.push(recipe);
      }
    }
    return recipes;
  }
  
  // FIX: Deduplicate category lists on save (performance optimization)
  saveBatch() {
    // Dedupe all category arrays
    for (const cat of Object.keys(this.index.byCategory)) {
      this.index.byCategory[cat] = [...new Set(this.index.byCategory[cat])];
    }
    
    this.saveIndex();
    this.saveMeta();
  }
  
  // Recalculate stats from actual data (useful after resume)
  recalcStats() {
    let withContent = 0;
    let withRecipes = 0;
    
    for (const page of Object.values(this.index.pages)) {
      if (page.hasContent) withContent++;
      if (page.hasRecipe) withRecipes++;
    }
    
    this.index.stats.total = Object.keys(this.index.pages).length;
    this.index.stats.withContent = withContent;
    this.index.stats.withRecipes = withRecipes;
    
    return this.index.stats;
  }
}

// ============================================================================
// CHECKPOINT SYSTEM
// ============================================================================

class Checkpoint {
  constructor(file) {
    this.file = file;
    this.data = this.load();
  }
  
  load() {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, "utf-8"));
      }
    } catch (e) {
      console.error(`Warning: Could not load checkpoint: ${e.message}`);
    }
    return {
      phase: null,
      progress: {},
      startedAt: null,
      lastUpdate: null
    };
  }
  
  save() {
    this.data.lastUpdate = new Date().toISOString();
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  
  startPhase(phase) {
    this.data.phase = phase;
    this.data.progress[phase] = { started: new Date().toISOString(), completed: false };
    if (!this.data.startedAt) this.data.startedAt = new Date().toISOString();
    this.save();
  }
  
  updateProgress(phase, key, value) {
    if (!this.data.progress[phase]) this.data.progress[phase] = {};
    this.data.progress[phase][key] = value;
    this.save();
  }
  
  completePhase(phase) {
    if (this.data.progress[phase]) {
      this.data.progress[phase].completed = true;
      this.data.progress[phase].completedAt = new Date().toISOString();
    }
    this.save();
  }
  
  getProgress(phase, key) {
    return this.data.progress[phase]?.[key];
  }
  
  isPhaseComplete(phase) {
    return this.data.progress[phase]?.completed === true;
  }
  
  clear() {
    this.data = { phase: null, progress: {}, startedAt: null, lastUpdate: null };
    this.save();
  }
}

// ============================================================================
// API CLIENT
// ============================================================================

class WurmpediaAPI {
  constructor() {
    this.lastRequest = 0;
  }
  
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  async rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < CONFIG.RATE_LIMIT_MS) {
      await this.sleep(CONFIG.RATE_LIMIT_MS - elapsed);
    }
    this.lastRequest = Date.now();
  }
  
  async fetch(params, retries = CONFIG.MAX_RETRIES) {
    await this.rateLimit();
    
    const url = new URL(CONFIG.API_BASE);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("format", "json");
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url.toString());
        
        if (response.status === 429) {
          const delay = Math.min(
            CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
            CONFIG.RETRY_MAX_DELAY_MS
          );
          console.log(`  ⚠️ Rate limited, waiting ${delay/1000}s...`);
          await this.sleep(delay);
          continue;
        }
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.error) {
          throw new Error(`API Error: ${data.error.info}`);
        }
        
        return data;
      } catch (error) {
        const isLast = attempt === retries;
        const delay = Math.min(
          CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          CONFIG.RETRY_MAX_DELAY_MS
        );
        
        console.error(`  ❌ Attempt ${attempt}/${retries}: ${error.message}`);
        
        if (!isLast) {
          console.log(`  ⏳ Retrying in ${delay/1000}s...`);
          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }
  }
  
  async* getAllPages() {
    let continueToken = null;
    
    while (true) {
      const params = {
        action: "query",
        list: "allpages",
        aplimit: "500",
        apnamespace: "0"
      };
      
      if (continueToken) {
        params.apcontinue = continueToken;
      }
      
      const data = await this.fetch(params);
      const pages = data.query?.allpages || [];
      
      for (const page of pages) {
        yield page;
      }
      
      if (data.continue?.apcontinue) {
        continueToken = data.continue.apcontinue;
      } else {
        break;
      }
    }
  }
  
  async getCategories(pageIds) {
    const params = {
      action: "query",
      prop: "categories",
      pageids: pageIds.join("|"),
      cllimit: "500"
    };
    
    const data = await this.fetch(params);
    const result = {};
    
    if (data.query?.pages) {
      for (const [pageId, pageData] of Object.entries(data.query.pages)) {
        result[pageId] = (pageData.categories || [])
          .map(c => c.title.replace(/^Category:/, ""))
          .filter(c => !c.startsWith("Pages ") && !c.includes("articles"));
      }
    }
    
    return result;
  }
  
  async getPageContent(pageid) {
    const params = {
      action: "parse",
      pageid: pageid.toString(),
      prop: "wikitext|text|categories|templates|sections"
    };
    
    const data = await this.fetch(params);
    
    if (data.parse) {
      return {
        pageid,
        title: data.parse.title,
        wikitext: data.parse.wikitext?.["*"] || "",
        html: data.parse.text?.["*"] || "",
        categories: (data.parse.categories || []).map(c => c["*"]),
        templates: (data.parse.templates || []).map(t => t["*"]),
        sections: data.parse.sections || []
      };
    }
    
    return null;
  }
  
  async getPageContents(pageIds) {
    const params = {
      action: "query",
      prop: "revisions|categories",
      pageids: pageIds.join("|"),
      rvprop: "content",
      rvslots: "main",
      cllimit: "500"
    };
    
    const data = await this.fetch(params);
    const results = {};
    
    if (data.query?.pages) {
      for (const [pageId, pageData] of Object.entries(data.query.pages)) {
        if (pageData.revisions?.[0]) {
          results[pageId] = {
            pageid: Number(pageId),
            title: pageData.title,
            wikitext: pageData.revisions[0].slots?.main?.["*"] || "",
            categories: (pageData.categories || []).map(c => c.title.replace(/^Category:/, ""))
          };
        }
      }
    }
    
    return results;
  }
}

// ============================================================================
// INFOBOX EXTRACTOR - Focused on wikitable infoboxes
// ============================================================================

class InfoboxExtractor {
  constructor() {
    // The infobox tables have these section headers
    this.knownSections = [
      'creation', 'total materials', 'result', 'skill and improvement',
      'properties', 'notes', 'ingredients', 'materials', 'tools',
      'cooking', 'container', 'cooker', 'skill', 'output'
    ];
  }
  
  /**
   * Extract infobox from HTML content
   * Targets: <table class="wikitable" style="float:right; margin:1em; width:250px;"
   */
  extractFromHTML(html) {
    if (!html) return null;
    
    // Find the infobox table (float:right wikitable)
    const infoboxPattern = /<table[^>]*class="wikitable"[^>]*style="[^"]*float:\s*right[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
    
    const infoboxes = [];
    let match;
    
    while ((match = infoboxPattern.exec(html)) !== null) {
      const tableHTML = match[0];
      const parsed = this.parseInfoboxTable(tableHTML);
      if (parsed && Object.keys(parsed.sections).length > 0) {
        infoboxes.push(parsed);
      }
    }
    
    return infoboxes.length > 0 ? infoboxes : null;
  }
  
  /**
   * Parse a single infobox table
   */
  parseInfoboxTable(tableHTML) {
    const result = {
      title: null,
      image: null,
      sections: {},
      raw: {}
    };
    
    // Extract caption (title)
    const captionMatch = tableHTML.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    if (captionMatch) {
      result.title = this.cleanText(captionMatch[1]);
    }
    
    // Extract image
    const imgMatch = tableHTML.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
    if (imgMatch) {
      result.image = imgMatch[1];
    }
    
    // Parse rows - split by <tr>
    const rows = tableHTML.split(/<tr[^>]*>/i).slice(1); // Skip first empty split
    
    let currentSection = null;
    
    for (const row of rows) {
      // Check if this is a header row
      const headerMatch = row.match(/<th[^>]*class="infobox-header-row"[^>]*>([\s\S]*?)<\/th>/i);
      if (headerMatch) {
        currentSection = this.cleanText(headerMatch[1]).toLowerCase();
        result.sections[currentSection] = [];
        continue;
      }
      
      // Also check for regular th (some wikis use plain th)
      const thMatch = row.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
      if (thMatch && !row.includes('<td')) {
        const headerText = this.cleanText(thMatch[1]).toLowerCase();
        if (this.knownSections.some(s => headerText.includes(s))) {
          currentSection = headerText;
          result.sections[currentSection] = [];
          continue;
        }
      }
      
      // This is a data row - extract content
      const tdMatch = row.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
      if (tdMatch && currentSection) {
        const content = this.parseDataCell(tdMatch[1]);
        if (content.length > 0) {
          result.sections[currentSection].push(...content);
        }
      }
    }
    
    // Post-process into structured data
    result.raw = { ...result.sections };
    this.structureSections(result);
    
    return result;
  }
  
  /**
   * Parse content from a data cell
   */
  parseDataCell(cellHTML) {
    const items = [];
    
    // Extract list items
    const listPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    
    while ((match = listPattern.exec(cellHTML)) !== null) {
      const text = this.cleanText(match[1]);
      if (text) {
        items.push(this.parseListItem(text, match[1]));
      }
    }
    
    // If no list items, get plain text
    if (items.length === 0) {
      const plainText = this.cleanText(cellHTML);
      if (plainText) {
        items.push({ text: plainText, links: this.extractLinks(cellHTML) });
      }
    }
    
    return items;
  }
  
  /**
   * Parse a single list item, extracting quantities, links, etc.
   */
  parseListItem(text, html) {
    const item = {
      text: text,
      links: this.extractLinks(html)
    };
    
    // Try to extract quantity patterns like "11x" or "2.00 kg"
    const qtyPatterns = [
      /^(\d+)x\s+(.+)$/i,                    // "11x bricks"
      /^(\d+(?:\.\d+)?)\s*kg\s+(.+)$/i,      // "2.00 kg clay"
      /^(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*kg\s+(.+)$/i,  // "11x 2.00 kg clay"
    ];
    
    for (const pattern of qtyPatterns) {
      const match = text.match(pattern);
      if (match) {
        if (match.length === 3) {
          item.quantity = parseFloat(match[1]);
          item.item = match[2].trim();
        } else if (match.length === 4) {
          item.count = parseInt(match[1]);
          item.quantity = parseFloat(match[2]);
          item.unit = 'kg';
          item.item = match[3].trim();
        }
        break;
      }
    }
    
    // Check for "Uses X skill" pattern
    const skillMatch = text.match(/uses?\s+(.+?)\s+skill/i);
    if (skillMatch) {
      item.skill = skillMatch[1];
    }
    
    // Check for "Improved using X" pattern
    const improveMatch = text.match(/improved?\s+(?:using|with)\s+(.+?)(?:\s+tools|\s+and|$)/i);
    if (improveMatch) {
      item.improveSkill = improveMatch[1];
    }
    
    // Check for "Activate X" pattern
    const activateMatch = text.match(/activate\s+(.+)/i);
    if (activateMatch) {
      item.activate = activateMatch[1];
    }
    
    // Check for "Right-click X" pattern
    const rightClickMatch = text.match(/right-click\s+(.+?)(?:\s*\(|$)/i);
    if (rightClickMatch) {
      item.target = rightClickMatch[1];
    }
    
    return item;
  }
  
  /**
   * Extract links from HTML
   */
  extractLinks(html) {
    const links = [];
    const linkPattern = /<a[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
    
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      links.push({
        href: match[1],
        title: match[2],
        text: match[3]
      });
    }
    
    return links;
  }
  
  /**
   * Clean HTML text
   */
  cleanText(html) {
    if (!html) return '';
    
    return html
      // Remove HTML tags but keep content
      .replace(/<[^>]+>/g, ' ')
      // Decode HTML entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Clean whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  /**
   * Structure the raw sections into a cleaner format
   */
  structureSections(result) {
    const structured = {
      creation: null,
      materials: [],
      result: null,
      skill: null,
      improveWith: null,
      properties: [],
      cooking: null
    };
    
    // Process Creation section
    if (result.sections['creation']) {
      const creation = { steps: [], activate: null, target: null };
      for (const item of result.sections['creation']) {
        if (item.activate) creation.activate = item.activate;
        if (item.target) creation.target = item.target;
        creation.steps.push(item.text);
      }
      structured.creation = creation;
    }
    
    // Process Total Materials section
    if (result.sections['total materials']) {
      for (const item of result.sections['total materials']) {
        if (item.item || item.links?.length > 0) {
          structured.materials.push({
            count: item.count || item.quantity || 1,
            quantity: item.quantity,
            unit: item.unit,
            item: item.item || item.links?.[0]?.text || item.text
          });
        }
      }
    }
    
    // Process Result section
    if (result.sections['result']) {
      const results = result.sections['result'];
      if (results.length > 0) {
        structured.result = results[0].links?.[0]?.text || results[0].text;
      }
    }
    
    // Process Skill section
    if (result.sections['skill and improvement']) {
      for (const item of result.sections['skill and improvement']) {
        if (item.skill) structured.skill = item.skill;
        if (item.improveSkill) structured.improveWith = item.improveSkill;
      }
    }
    
    // Process Properties section
    if (result.sections['properties']) {
      structured.properties = result.sections['properties'].map(p => p.text);
    }
    
    // Process Cooking sections (for food items)
    const cookingSections = ['cooking', 'container', 'cooker', 'ingredients'];
    for (const section of cookingSections) {
      if (result.sections[section]) {
        if (!structured.cooking) structured.cooking = {};
        structured.cooking[section] = result.sections[section];
      }
    }
    
    result.structured = structured;
  }
  
  /**
   * Main extraction method - extracts from page content
   */
  extract(pageData) {
    const html = pageData.html || '';
    const wikitext = pageData.wikitext || '';
    
    // Try HTML first (more reliable structure)
    let infoboxes = this.extractFromHTML(html);
    
    // If no HTML, try to extract from wikitext
    if (!infoboxes && wikitext) {
      infoboxes = this.extractFromWikitext(wikitext);
    }
    
    if (!infoboxes || infoboxes.length === 0) {
      return null;
    }
    
    // Return structured result
    return {
      pageid: pageData.pageid,
      title: pageData.title,
      categories: pageData.categories || [],
      infoboxes: infoboxes,
      // Flatten first infobox for easy access
      primary: infoboxes[0]?.structured || null,
      hasCreation: infoboxes.some(ib => ib.sections['creation']),
      hasMaterials: infoboxes.some(ib => ib.sections['total materials']),
      hasCooking: infoboxes.some(ib => 
        ib.sections['cooking'] || ib.sections['cooker'] || ib.sections['container']
      )
    };
  }
  
  /**
   * Extract from wikitext (fallback when no HTML)
   */
  extractFromWikitext(wikitext) {
    // Look for wikitable in wikitext format
    const tablePattern = /\{\|\s*class="wikitable"[^}]*\|[\s\S]*?\|\}/gi;
    
    const tables = [];
    let match;
    
    while ((match = tablePattern.exec(wikitext)) !== null) {
      const parsed = this.parseWikitextTable(match[0]);
      if (parsed && Object.keys(parsed.sections).length > 0) {
        tables.push(parsed);
      }
    }
    
    return tables.length > 0 ? tables : null;
  }
  
  /**
   * Parse wikitext table format
   */
  parseWikitextTable(tableText) {
    const result = {
      title: null,
      sections: {},
      structured: {}
    };
    
    // Extract caption
    const captionMatch = tableText.match(/\|\+\s*(.+)/);
    if (captionMatch) {
      result.title = captionMatch[1].trim();
    }
    
    // Split by rows (|-)
    const rows = tableText.split(/\|-/);
    let currentSection = null;
    
    for (const row of rows) {
      // Check for header (!)
      const headerMatch = row.match(/!\s*(.+)/);
      if (headerMatch) {
        currentSection = headerMatch[1].trim().toLowerCase();
        result.sections[currentSection] = [];
        continue;
      }
      
      // Check for data cells (|)
      const cellMatch = row.match(/\|\s*([\s\S]+)/);
      if (cellMatch && currentSection) {
        // Extract list items
        const items = cellMatch[1].match(/\*\s*(.+)/g);
        if (items) {
          for (const item of items) {
            const text = item.replace(/^\*\s*/, '').trim();
            // Clean wiki links [[Link|Text]] -> Text
            const cleaned = text
              .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
              .replace(/\[\[([^\]]+)\]\]/g, '$1');
            result.sections[currentSection].push({ text: cleaned });
          }
        }
      }
    }
    
    this.structureSections(result);
    return result;
  }
}

// ============================================================================
// PROGRESS TRACKER
// ============================================================================

class ProgressTracker {
  constructor(total, label = "Progress") {
    this.total = total;
    this.current = 0;
    this.label = label;
    this.startTime = Date.now();
    this.lastUpdate = 0;
  }
  
  update(current) {
    this.current = current;
    const now = Date.now();
    
    if (now - this.lastUpdate < 500) return;
    this.lastUpdate = now;
    
    const percent = ((current / this.total) * 100).toFixed(1);
    const elapsed = (now - this.startTime) / 1000;
    const rate = current / elapsed;
    const remaining = rate > 0 ? (this.total - current) / rate : 0;
    const eta = remaining > 0 ? this.formatTime(remaining) : "Done";
    
    process.stdout.write(`\r${this.label}: ${current}/${this.total} (${percent}%) | ETA: ${eta}      `);
  }
  
  increment() {
    this.update(this.current + 1);
  }
  
  formatTime(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  }
  
  done() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    console.log(`\r${this.label}: ${this.total}/${this.total} (100%) | Completed in ${this.formatTime(elapsed)}`);
  }
}

// ============================================================================
// MAIN HARVESTER
// ============================================================================

class WurmpediaHarvester {
  constructor() {
    this.api = new WurmpediaAPI();
    this.db = new SimpleDB(CONFIG.DATA_DIR);
    this.checkpoint = new Checkpoint(CONFIG.CHECKPOINT_FILE);
    this.extractor = new InfoboxExtractor();
  }
  
  async harvestPages() {
    console.log("\n📡 Phase 1: Fetching all pages...\n");
    
    if (this.checkpoint.isPhaseComplete("pages")) {
      console.log("  ✅ Pages already harvested, skipping...");
      return;
    }
    
    this.checkpoint.startPhase("pages");
    
    let count = 0;
    const batchSize = 50;  // API limit for pageids
    let batch = [];
    
    for await (const page of this.api.getAllPages()) {
      batch.push(page);
      count++;
      
      if (batch.length >= batchSize) {
        const pageIds = batch.map(p => p.pageid);
        const categories = await this.api.getCategories(pageIds);
        
        for (const p of batch) {
          this.db.addPage(p.pageid, p.title, p.ns, categories[p.pageid] || []);
        }
        
        this.db.saveBatch();
        this.checkpoint.updateProgress("pages", "count", count);
        
        console.log(`  📦 Processed ${count} pages...`);
        batch = [];
      }
    }
    
    if (batch.length > 0) {
      const pageIds = batch.map(p => p.pageid);
      const categories = await this.api.getCategories(pageIds);
      
      for (const p of batch) {
        this.db.addPage(p.pageid, p.title, p.ns, categories[p.pageid] || []);
      }
      
      this.db.saveBatch();
    }
    
    this.checkpoint.completePhase("pages");
    console.log(`\n  ✅ Harvested ${count} pages total\n`);
  }
  
  async harvestContent() {
    console.log("\n📄 Phase 2: Fetching page content...\n");
    
    // Get pages that need content
    const pageIds = this.db.getPagesWithoutContent();
    const total = pageIds.length;
    
    console.log(`  📊 Pages needing content: ${total}`);
    
    // Also show total pages and breakdown
    const allPages = this.db.getAllPageIds();
    const withContent = this.db.getPagesWithContent();
    console.log(`  📊 Total pages: ${allPages.length}, already have content: ${withContent.length}\n`);
    
    if (total === 0) {
      if (withContent.length > 0) {
        console.log("  ✅ All pages already have content, skipping...");
        this.checkpoint.completePhase("content");
      } else {
        console.log("  ⚠️ No pages found to fetch content for!");
        console.log("  💡 Check if pages were harvested with ns=0 (main namespace)");
        
        // Debug: show namespace distribution
        const nsDist = {};
        for (const page of Object.values(this.db.index.pages)) {
          nsDist[page.ns] = (nsDist[page.ns] || 0) + 1;
        }
        console.log("  📊 Namespace distribution:", nsDist);
      }
      return;
    }
    
    if (this.checkpoint.isPhaseComplete("content") && withContent.length > 0) {
      console.log("  ✅ Content already harvested, skipping...");
      return;
    }
    
    this.checkpoint.startPhase("content");
    
    // We need to fetch each page individually to get HTML (for infobox extraction)
    // action=parse gives us both wikitext and rendered HTML
    console.log("  📝 Note: Fetching with HTML for infobox extraction (slower but better data)\n");
    
    const progress = new ProgressTracker(total, "  Fetching");
    let processed = 0;
    let errors = 0;
    let withInfobox = 0;
    
    for (const pageId of pageIds) {
      try {
        const content = await this.api.getPageContent(pageId);
        if (content) {
          this.db.saveContent(pageId, content);
          processed++;
          
          // Track infobox presence
          if (content.html && content.html.includes('class="wikitable"')) {
            withInfobox++;
          }
        }
        progress.update(processed);
        
        if (processed % 100 === 0) {
          this.db.saveBatch();
          this.checkpoint.updateProgress("content", "processed", processed);
          this.checkpoint.updateProgress("content", "withInfobox", withInfobox);
        }
      } catch (e) {
        console.error(`\n  ❌ Failed ${pageId}: ${e.message}`);
        errors++;
      }
    }
    
    progress.done();
    this.db.saveBatch();
    this.checkpoint.completePhase("content");
    
    console.log(`\n  ✅ Fetched ${processed} pages (${errors} errors)`);
    console.log(`  📊 Pages with infobox tables: ${withInfobox}\n`);
  }
  
  async extractRecipes() {
    console.log("\n🍳 Phase 3: Extracting infoboxes...\n");
    
    this.checkpoint.startPhase("recipes");
    
    // Clear old recipes for re-extraction
    const recipeFiles = fs.readdirSync(this.db.recipesDir);
    for (const f of recipeFiles) {
      fs.unlinkSync(path.join(this.db.recipesDir, f));
    }
    
    // Reset recipe stats
    for (const page of Object.values(this.db.index.pages)) {
      page.hasRecipe = false;
    }
    this.db.index.stats.withRecipes = 0;
    
    const pageIds = this.db.getPagesWithContent();
    const progress = new ProgressTracker(pageIds.length, "  Extracting");
    
    let extracted = 0;
    let checked = 0;
    let withCreation = 0;
    let withMaterials = 0;
    let withCooking = 0;
    
    for (const pageId of pageIds) {
      const content = this.db.getContent(pageId);
      
      if (content) {
        const infobox = this.extractor.extract(content);
        
        if (infobox) {
          this.db.saveRecipe(pageId, infobox);
          extracted++;
          
          // Track types
          if (infobox.hasCreation) withCreation++;
          if (infobox.hasMaterials) withMaterials++;
          if (infobox.hasCooking) withCooking++;
        }
      }
      
      checked++;
      progress.update(checked);
      
      if (checked % 500 === 0) {
        this.db.saveBatch();
      }
    }
    
    progress.done();
    this.db.saveBatch();
    this.checkpoint.completePhase("recipes");
    
    console.log(`\n  ✅ Extracted ${extracted} infoboxes from ${checked} pages`);
    console.log(`  📊 With Creation section: ${withCreation}`);
    console.log(`  📊 With Materials section: ${withMaterials}`);
    console.log(`  📊 With Cooking data: ${withCooking}\n`);
  }
  
  async harvest() {
    console.log("🔨 Wurmpedia Complete Harvester v2.1");
    console.log("=====================================\n");
    
    const startTime = Date.now();
    
    await this.harvestPages();
    await this.harvestContent();
    await this.extractRecipes();
    
    const elapsed = (Date.now() - startTime) / 1000;
    
    console.log("\n=====================================");
    console.log("✅ Harvest complete!\n");
    
    this.showStats();
    
    console.log(`\n⏱️  Total time: ${(elapsed / 60).toFixed(1)} minutes`);
  }
  
  async resume() {
    console.log("🔄 Resuming harvest...\n");
    
    // Recalc stats first to fix any double-counting from previous runs
    console.log("  📊 Recalculating stats...");
    const stats = this.db.recalcStats();
    console.log(`     Total: ${stats.total}, Content: ${stats.withContent}, Recipes: ${stats.withRecipes}\n`);
    
    if (!this.checkpoint.isPhaseComplete("pages")) {
      await this.harvestPages();
    }
    
    if (!this.checkpoint.isPhaseComplete("content")) {
      await this.harvestContent();
    }
    
    if (!this.checkpoint.isPhaseComplete("recipes")) {
      await this.extractRecipes();
    }
    
    console.log("\n✅ Resume complete!");
    this.showStats();
  }
  
  showStats() {
    // Always recalc for accurate numbers
    const stats = this.db.recalcStats();
    
    console.log("📊 Database Statistics:");
    console.log(`   Total pages: ${stats.total}`);
    console.log(`   With content: ${stats.withContent}`);
    console.log(`   With infobox: ${stats.withRecipes}`);
    
    const cats = Object.entries(this.db.index.byCategory)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 15);
    
    console.log("\n🏷️  Top categories:");
    for (const [cat, pages] of cats) {
      console.log(`   ${cat}: ${pages.length} pages`);
    }
    
    const infoboxes = this.db.getAllRecipes();
    
    // Count by section type
    let withCreation = 0, withMaterials = 0, withCooking = 0, withSkill = 0;
    
    for (const ib of infoboxes) {
      if (ib.hasCreation) withCreation++;
      if (ib.hasMaterials) withMaterials++;
      if (ib.hasCooking) withCooking++;
      if (ib.primary?.skill) withSkill++;
    }
    
    console.log("\n📋 Infobox extraction:");
    console.log(`   Total infoboxes: ${infoboxes.length}`);
    console.log(`   With Creation section: ${withCreation}`);
    console.log(`   With Materials section: ${withMaterials}`);
    console.log(`   With Cooking data: ${withCooking}`);
    console.log(`   With Skill info: ${withSkill}`);
  }
  
  async export() {
    console.log("\n📦 Exporting to JSON files...\n");
    
    const exportDir = path.join(CONFIG.DATA_DIR, "export");
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    // Pages
    const pagesFile = path.join(exportDir, "pages.json");
    const pages = Object.entries(this.db.index.pages).map(([id, p]) => ({
      pageid: Number(id),
      ...p
    }));
    fs.writeFileSync(pagesFile, JSON.stringify(pages, null, 2));
    console.log(`  ✅ Exported ${pages.length} pages`);
    
    // All infoboxes
    const infoboxes = this.db.getAllRecipes();
    
    const infoboxesFile = path.join(exportDir, "infoboxes.json");
    fs.writeFileSync(infoboxesFile, JSON.stringify(infoboxes, null, 2));
    console.log(`  ✅ Exported ${infoboxes.length} infoboxes`);
    
    // With Creation section (crafting recipes)
    const craftingFile = path.join(exportDir, "crafting.json");
    const crafting = infoboxes.filter(ib => ib.hasCreation);
    fs.writeFileSync(craftingFile, JSON.stringify(crafting, null, 2));
    console.log(`  ✅ Exported ${crafting.length} crafting items`);
    
    // With Materials section
    const materialsFile = path.join(exportDir, "with-materials.json");
    const withMaterials = infoboxes.filter(ib => ib.hasMaterials);
    fs.writeFileSync(materialsFile, JSON.stringify(withMaterials, null, 2));
    console.log(`  ✅ Exported ${withMaterials.length} items with materials`);
    
    // With Cooking data
    const cookingFile = path.join(exportDir, "cooking.json");
    const cooking = infoboxes.filter(ib => ib.hasCooking);
    fs.writeFileSync(cookingFile, JSON.stringify(cooking, null, 2));
    console.log(`  ✅ Exported ${cooking.length} cooking items`);
    
    // Simplified/flattened format for easy use
    const simplifiedFile = path.join(exportDir, "simplified.json");
    const simplified = infoboxes.map(ib => ({
      pageid: ib.pageid,
      title: ib.title,
      categories: ib.categories,
      // Flatten primary data
      skill: ib.primary?.skill || null,
      improveWith: ib.primary?.improveWith || null,
      materials: ib.primary?.materials || [],
      result: ib.primary?.result || ib.title,
      creation: ib.primary?.creation || null,
      properties: ib.primary?.properties || []
    }));
    fs.writeFileSync(simplifiedFile, JSON.stringify(simplified, null, 2));
    console.log(`  ✅ Exported ${simplified.length} simplified records`);
    
    // Categories
    const categoriesFile = path.join(exportDir, "categories.json");
    fs.writeFileSync(categoriesFile, JSON.stringify(this.db.index.byCategory, null, 2));
    console.log(`  ✅ Exported ${Object.keys(this.db.index.byCategory).length} categories`);
    
    // Summary
    const summaryFile = path.join(exportDir, "summary.json");
    const summary = {
      exportedAt: new Date().toISOString(),
      stats: this.db.recalcStats(),
      infoboxStats: {
        total: infoboxes.length,
        withCreation: crafting.length,
        withMaterials: withMaterials.length,
        withCooking: cooking.length
      }
    };
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    console.log(`  ✅ Exported summary`);
    
    console.log(`\n  📁 Files saved to: ${exportDir}`);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "harvest";
  
  const harvester = new WurmpediaHarvester();
  
  try {
    switch (command) {
      case "harvest":
        await harvester.harvest();
        break;
      
      case "pages":
        await harvester.harvestPages();
        harvester.db.saveBatch();
        break;
      
      case "content":
        await harvester.harvestContent();
        break;
      
      case "recipes":
        await harvester.extractRecipes();
        break;
      
      case "resume":
        await harvester.resume();
        break;
      
      case "stats":
        harvester.showStats();
        break;
      
      case "export":
        await harvester.export();
        break;
      
      case "clear":
        harvester.checkpoint.clear();
        console.log("✅ Checkpoint cleared");
        break;
      
      case "recalc":
        console.log("📊 Recalculating stats...");
        const stats = harvester.db.recalcStats();
        harvester.db.saveBatch();
        console.log(stats);
        break;
      
      case "force-content":
        console.log("🔄 Forcing content fetch (clearing content checkpoint)...");
        harvester.checkpoint.data.progress.content = null;
        harvester.checkpoint.save();
        await harvester.harvestContent();
        break;
      
      case "debug":
        console.log("🔍 Debug info:");
        console.log("  Namespace distribution:", harvester.db.getNamespaceDistribution());
        console.log("  Pages without content:", harvester.db.getPagesWithoutContent().length);
        console.log("  Pages with content:", harvester.db.getPagesWithContent().length);
        console.log("  Checkpoint:", harvester.checkpoint.data);
        break;
      
      default:
        console.log(`
Wurmpedia Harvester v2.1

Usage: node harvest-wurmpedia-v2.1.js [command]

Commands:
  harvest        Full harvest (pages + content + recipes) [default]
  pages          Only fetch page list
  content        Fetch content for pages in database
  recipes        Extract recipes from stored content
  resume         Resume interrupted harvest
  stats          Show database statistics
  export         Export to JSON files
  clear          Clear checkpoint (restart from beginning)
  recalc         Recalculate stats from actual data
  force-content  Force re-fetch content (clears content checkpoint)
  debug          Show debug info (namespace distribution, etc)
        `);
    }
  } catch (error) {
    console.error(`\n❌ Fatal error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
