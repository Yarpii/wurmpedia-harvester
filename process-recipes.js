#!/usr/bin/env node

/**
 * Wurmpedia Data Processor
 * 
 * Transforms raw infobox extractions into clean, structured recipe data.
 * 
 * Input:  data/recipes/*.json (infobox extractions)
 * Output: data/processed/*.json (clean recipe data)
 * 
 * Usage: node process-recipes.js
 */

const fs = require("fs");
const path = require("path");

const CONFIG = {
  INPUT_DIR: path.join(__dirname, "data", "recipes"),
  OUTPUT_DIR: path.join(__dirname, "data", "processed"),
};

// Ensure output directory exists
if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
  fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
}

/**
 * Clean and normalize item names
 */
function normalizeItemName(name) {
  if (!name) return null;
  
  return name
    // Remove quantities like "(2.0 kg)" or "(0.10 kg)"
    .replace(/\s*\([^)]*kg\)/gi, "")
    // Remove leading/trailing whitespace
    .trim()
    // Normalize multiple spaces
    .replace(/\s+/g, " ");
}

/**
 * Parse quantity from text like "2.0 kg" or "20x"
 */
function parseQuantity(text) {
  if (!text) return { count: 1, weight: null };
  
  const result = { count: 1, weight: null };
  
  // Check for "Nx" pattern (e.g., "20x Plank")
  const countMatch = text.match(/^(\d+)x?\s/i);
  if (countMatch) {
    result.count = parseInt(countMatch[1]);
  }
  
  // Check for weight pattern (e.g., "(2.0 kg)" or "2.0 kg")
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*kg/i);
  if (weightMatch) {
    result.weight = parseFloat(weightMatch[1]);
  }
  
  return result;
}

/**
 * Extract tool from "Activate X" text
 */
function extractTool(text) {
  if (!text) return null;
  
  // Handle "Activate X" pattern
  const activateMatch = text.match(/activate\s+(.+)/i);
  if (activateMatch) {
    let tool = activateMatch[1].trim();
    // Handle "X or Y" pattern
    if (tool.toLowerCase().includes(" or ")) {
      return tool.split(/\s+or\s+/i).map(t => normalizeItemName(t));
    }
    return [normalizeItemName(tool)];
  }
  
  return null;
}

/**
 * Extract target from "Right-click X" text
 */
function extractTarget(text) {
  if (!text) return null;
  
  const match = text.match(/right-click\s+(.+?)(?:\s*\(|$)/i);
  if (match) {
    return normalizeItemName(match[1]);
  }
  
  return null;
}

/**
 * Extract submenu path from "Open submenu/menu" text
 */
function extractMenu(text) {
  if (!text) return null;
  
  const match = text.match(/(?:open\s+)?(?:sub)?menu\s*[">]\s*(.+)/i);
  if (match) {
    // Clean up menu path
    return match[1]
      .replace(/["']/g, "")
      .replace(/\s*>\s*/g, " > ")
      .trim();
  }
  
  return null;
}

/**
 * Process a single infobox into clean recipe format
 */
function processInfobox(data) {
  const infobox = data.infoboxes?.[0];
  if (!infobox) return null;
  
  const recipe = {
    // Basic info
    id: data.pageid,
    name: normalizeItemName(data.title),
    categories: data.categories || [],
    image: infobox.image ? `https://wurmpedia.com${infobox.image}` : null,
    
    // Creation info
    creation: null,
    
    // Materials
    materials: [],
    
    // Result
    result: null,
    
    // Skill info
    skill: null,
    canImprove: true,
    improveWith: null,
    
    // Properties
    properties: [],
    
    // Notes
    notes: [],
    
    // Flags
    isCooking: data.hasCooking || false,
    hasMaterials: data.hasMaterials || false,
  };
  
  // Process Creation section
  if (infobox.sections?.creation) {
    const creation = {
      tools: [],
      target: null,
      targetQuantity: null,
      menu: null,
      steps: []
    };
    
    for (const item of infobox.sections.creation) {
      const text = item.text || "";
      
      // Extract tool from "Activate X"
      if (item.activate || text.toLowerCase().includes("activate")) {
        const tools = extractTool(text);
        if (tools) creation.tools.push(...tools);
      }
      
      // Extract target from "Right-click X"
      if (item.target || text.toLowerCase().includes("right-click")) {
        creation.target = extractTarget(text) || item.target;
        const qty = parseQuantity(text);
        if (qty.weight) creation.targetQuantity = qty.weight;
      }
      
      // Extract menu path
      if (text.toLowerCase().includes("menu")) {
        creation.menu = extractMenu(text);
      }
      
      // Store raw step
      creation.steps.push(text);
    }
    
    // Clean up tools array
    creation.tools = [...new Set(creation.tools.filter(Boolean))];
    
    recipe.creation = creation;
  }
  
  // Process Materials section
  if (infobox.sections?.["total materials"]) {
    for (const item of infobox.sections["total materials"]) {
      const qty = parseQuantity(item.text);
      const name = item.item || normalizeItemName(
        item.links?.[0]?.text || item.text?.replace(/^\d+x?\s*/i, "")
      );
      
      if (name) {
        recipe.materials.push({
          name: normalizeItemName(name),
          count: item.quantity || item.count || qty.count,
          weight: qty.weight
        });
      }
    }
  }
  
  // Process Result section
  if (infobox.sections?.result) {
    const resultItem = infobox.sections.result[0];
    if (resultItem) {
      const qty = parseQuantity(resultItem.text);
      recipe.result = {
        name: normalizeItemName(resultItem.text),
        weight: qty.weight
      };
    }
  }
  
  // Process Skill section
  if (infobox.sections?.["skill and improvement"]) {
    for (const item of infobox.sections["skill and improvement"]) {
      const text = item.text || "";
      
      // Extract skill
      if (item.skill) {
        recipe.skill = item.skill;
      } else if (text.toLowerCase().includes("uses")) {
        const skillMatch = text.match(/uses?\s+(.+?)\s+skill/i);
        if (skillMatch) recipe.skill = skillMatch[1];
      }
      
      // Check for "Cannot be improved"
      if (text.toLowerCase().includes("cannot be improved")) {
        recipe.canImprove = false;
      }
      
      // Extract improvement info
      if (item.improveSkill) {
        recipe.improveWith = item.improveSkill;
      } else if (text.toLowerCase().includes("improved")) {
        const improveMatch = text.match(/improved?\s+(?:using|with)\s+(.+?)(?:\s+tools|\s+and|$)/i);
        if (improveMatch) recipe.improveWith = improveMatch[1];
      }
    }
  }
  
  // Process Properties section
  if (infobox.sections?.properties) {
    recipe.properties = infobox.sections.properties
      .map(p => p.text)
      .filter(Boolean);
  }
  
  // Process Notes section
  if (infobox.sections?.notes) {
    recipe.notes = infobox.sections.notes
      .map(n => n.text)
      .filter(Boolean);
  }
  
  // Set result name if not found
  if (!recipe.result) {
    recipe.result = { name: recipe.name, weight: null };
  }
  
  return recipe;
}

/**
 * Categorize recipe by type
 */
function categorizeRecipe(recipe) {
  const cats = recipe.categories.map(c => c.toLowerCase());
  const name = recipe.name.toLowerCase();
  
  // Determine type based on categories and content
  if (recipe.isCooking || cats.some(c => c.includes("cooking") || c.includes("food"))) {
    return "cooking";
  }
  
  if (cats.some(c => c.includes("weapon"))) return "weapon";
  if (cats.some(c => c.includes("armor") || c.includes("armour"))) return "armor";
  if (cats.some(c => c.includes("tool"))) return "tool";
  if (cats.some(c => c.includes("furniture"))) return "furniture";
  if (cats.some(c => c.includes("container"))) return "container";
  if (cats.some(c => c.includes("decoration"))) return "decoration";
  if (cats.some(c => c.includes("structure") || c.includes("wall") || c.includes("door"))) return "structure";
  if (cats.some(c => c.includes("vehicle") || c.includes("ship") || c.includes("cart"))) return "vehicle";
  
  // By skill
  const skill = (recipe.skill || "").toLowerCase();
  if (skill.includes("blacksmith") || skill.includes("smith")) return "smithing";
  if (skill.includes("carpentry")) return "carpentry";
  if (skill.includes("masonry")) return "masonry";
  if (skill.includes("pottery")) return "pottery";
  if (skill.includes("tailor") || skill.includes("cloth")) return "tailoring";
  if (skill.includes("leather")) return "leatherworking";
  
  return "misc";
}

/**
 * Main processing function
 */
function main() {
  console.log("🔧 Wurmpedia Data Processor");
  console.log("===========================\n");
  
  // Check input directory exists
  if (!fs.existsSync(CONFIG.INPUT_DIR)) {
    console.error("❌ Input directory not found:", CONFIG.INPUT_DIR);
    console.log("   Run the harvester first: node harvest-wurmpedia-v2.1.js harvest");
    process.exit(1);
  }
  
  // Read all infobox files
  const files = fs.readdirSync(CONFIG.INPUT_DIR).filter(f => f.endsWith(".json"));
  console.log(`📂 Found ${files.length} infobox files\n`);
  
  const recipes = [];
  const byType = {};
  const bySkill = {};
  let processed = 0;
  let skipped = 0;
  
  for (const file of files) {
    const filepath = path.join(CONFIG.INPUT_DIR, file);
    
    try {
      const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
      const recipe = processInfobox(data);
      
      if (recipe) {
        // Add type
        recipe.type = categorizeRecipe(recipe);
        
        recipes.push(recipe);
        processed++;
        
        // Track by type
        if (!byType[recipe.type]) byType[recipe.type] = [];
        byType[recipe.type].push(recipe);
        
        // Track by skill
        if (recipe.skill) {
          const skill = recipe.skill.toLowerCase();
          if (!bySkill[skill]) bySkill[skill] = [];
          bySkill[skill].push(recipe);
        }
      } else {
        skipped++;
      }
    } catch (e) {
      console.error(`  ⚠️ Error processing ${file}: ${e.message}`);
      skipped++;
    }
  }
  
  console.log(`✅ Processed: ${processed}`);
  console.log(`⏭️  Skipped: ${skipped}\n`);
  
  // Sort recipes by name
  recipes.sort((a, b) => a.name.localeCompare(b.name));
  
  // Save all recipes
  const allFile = path.join(CONFIG.OUTPUT_DIR, "all-recipes.json");
  fs.writeFileSync(allFile, JSON.stringify(recipes, null, 2));
  console.log(`📄 Saved: all-recipes.json (${recipes.length} items)`);
  
  // Save by type
  for (const [type, items] of Object.entries(byType)) {
    items.sort((a, b) => a.name.localeCompare(b.name));
    const typeFile = path.join(CONFIG.OUTPUT_DIR, `type-${type}.json`);
    fs.writeFileSync(typeFile, JSON.stringify(items, null, 2));
    console.log(`📄 Saved: type-${type}.json (${items.length} items)`);
  }
  
  // Save by skill
  for (const [skill, items] of Object.entries(bySkill)) {
    items.sort((a, b) => a.name.localeCompare(b.name));
    const skillFile = path.join(CONFIG.OUTPUT_DIR, `skill-${skill.replace(/\s+/g, "-")}.json`);
    fs.writeFileSync(skillFile, JSON.stringify(items, null, 2));
    console.log(`📄 Saved: skill-${skill}.json (${items.length} items)`);
  }
  
  // Save compact version (minimal data)
  const compact = recipes.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    skill: r.skill,
    tools: r.creation?.tools || [],
    target: r.creation?.target,
    materials: r.materials.map(m => ({
      name: m.name,
      count: m.count,
      weight: m.weight
    })),
    canImprove: r.canImprove
  }));
  const compactFile = path.join(CONFIG.OUTPUT_DIR, "compact.json");
  fs.writeFileSync(compactFile, JSON.stringify(compact, null, 2));
  console.log(`📄 Saved: compact.json (${compact.length} items)`);
  
  // Save summary
  const summary = {
    processedAt: new Date().toISOString(),
    totalRecipes: recipes.length,
    byType: Object.fromEntries(
      Object.entries(byType)
        .map(([k, v]) => [k, v.length])
        .sort((a, b) => b[1] - a[1])
    ),
    bySkill: Object.fromEntries(
      Object.entries(bySkill)
        .map(([k, v]) => [k, v.length])
        .sort((a, b) => b[1] - a[1])
    ),
    withMaterials: recipes.filter(r => r.materials.length > 0).length,
    cannotImprove: recipes.filter(r => !r.canImprove).length
  };
  const summaryFile = path.join(CONFIG.OUTPUT_DIR, "summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  
  // Print summary
  console.log("\n📊 Summary:");
  console.log(`   Total recipes: ${summary.totalRecipes}`);
  console.log(`   With materials: ${summary.withMaterials}`);
  console.log(`   Cannot improve: ${summary.cannotImprove}`);
  
  console.log("\n📊 By Type:");
  for (const [type, count] of Object.entries(summary.byType).slice(0, 10)) {
    console.log(`   ${type}: ${count}`);
  }
  
  console.log("\n📊 By Skill:");
  for (const [skill, count] of Object.entries(summary.bySkill).slice(0, 10)) {
    console.log(`   ${skill}: ${count}`);
  }
  
  console.log(`\n📁 Output: ${CONFIG.OUTPUT_DIR}`);
}

main();
