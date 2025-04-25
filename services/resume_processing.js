const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for OpenAI
const openaiApiKey = process.env.OPENAI_API_KEY;
const lmCache = new Map();

// Common section identifiers for resume parsing
const SECTION_IDENTIFIERS = {
    experience: ['experience', 'employment', 'work history', 'professional experience', 'work experience', 'career history'],
    education: ['education', 'academic background', 'academic history', 'qualifications', 'educational background'],
    projects: ['projects', 'personal projects', 'professional projects', 'key projects', 'relevant projects'],
    skills: ['skills', 'technical skills', 'core competencies', 'expertise', 'technologies', 'technical expertise']
};

class ResumeTemplateAnalyzer {
    constructor(htmlContent) {
        this.$ = cheerio.load(htmlContent);
        this.templateFingerprint = {};
        this.styleMap = new Map();
        this.sectionMap = new Map();
    }

    analyzeTemplate() {
        this._extractStyles();
        this._identifySections();
        this._analyzeStructure();
        return {
            sections: this.sectionMap,
            styles: this.styleMap,
            structure: this.templateFingerprint
        };
    }

    _extractStyles() {
        // Extract and preserve all styles
        this.$('style').each((_, el) => {
            const styleContent = this.$(el).html();
            if (styleContent) {
                this.styleMap.set(`style_${_}`, styleContent);
            }
        });

        // Extract inline styles
        this.$('[style]').each((_, el) => {
            const inlineStyle = this.$(el).attr('style');
            if (inlineStyle) {
                this.styleMap.set(this._generateStyleId(el), inlineStyle);
            }
        });
    }

    _identifySections() {
        // Method 1: HTML5 Semantic Tags
        this._findSectionsBySemantic();
        
        // Method 2: Common Class/ID Patterns
        this._findSectionsByClassId();
        
        // Method 3: Content-based Detection
        this._findSectionsByContent();
        
        // Method 4: Structural Analysis
        this._findSectionsByStructure();
    }

    _findSectionsBySemantic() {
        this.$('section, article').each((_, el) => {
            const sectionType = this._determineSectionType(el);
            if (sectionType) {
                this.sectionMap.set(this.$(el), sectionType);
            }
        });
    }

    _findSectionsByClassId() {
        // Search for elements with class/id containing section identifiers
        Object.entries(SECTION_IDENTIFIERS).forEach(([type, keywords]) => {
            keywords.forEach(keyword => {
                const selector = `[class*="${keyword}"],[id*="${keyword}"]`;
                this.$(selector).each((_, el) => {
                    if (!this.sectionMap.has(this.$(el))) {
                        this.sectionMap.set(this.$(el), type);
                    }
                });
            });
        });
    }

    _findSectionsByContent() {
        // Look for headings and div containers
        this.$('h1, h2, h3, h4, h5, h6').each((_, el) => {
            const headingText = this.$(el).text().toLowerCase();
            const sectionType = this._determineSectionTypeFromText(headingText);
            if (sectionType) {
                // Find the containing section
                const section = this.$(el).closest('div, section, article');
                if (section.length && !this.sectionMap.has(section)) {
                    this.sectionMap.set(section, sectionType);
                }
            }
        });
    }

    _findSectionsByStructure() {
        // Analyze document structure for implicit sections
        this.$('div').each((_, el) => {
            const $el = this.$(el);
            // Check if this div contains list items and a heading-like element
            if ($el.find('ul, ol').length && $el.find('h1, h2, h3, h4, h5, h6, .heading, strong:first-child').length) {
                const sectionType = this._determineSectionTypeFromStructure($el);
                if (sectionType && !this.sectionMap.has($el)) {
                    this.sectionMap.set($el, sectionType);
                }
            }
        });
    }

    _determineSectionType(element) {
        const $el = this.$(element);
        const text = $el.text().toLowerCase();
        const classNames = $el.attr('class') || '';
        const id = $el.attr('id') || '';
        
        return this._determineSectionTypeFromText(text) ||
               this._determineSectionTypeFromText(classNames) ||
               this._determineSectionTypeFromText(id);
    }

    _determineSectionTypeFromText(text) {
        for (const [type, keywords] of Object.entries(SECTION_IDENTIFIERS)) {
            if (keywords.some(keyword => text.includes(keyword.toLowerCase()))) {
                return type;
            }
        }
        return null;
    }

    _determineSectionTypeFromStructure($el) {
        // Analyze content patterns to determine section type
        const hasDatePatterns = $el.text().match(/\b(19|20)\d{2}\b/);
        const hasBulletPoints = $el.find('li').length > 0;
        const hasCompanyLikeWords = $el.text().match(/\b(company|inc|corp|ltd)\b/i);
        
        if (hasDatePatterns && hasBulletPoints) {
            return hasCompanyLikeWords ? 'experience' : 'education';
        }
        return null;
    }

    _generateStyleId(element) {
        const $el = this.$(element);
        const tagName = $el.prop('tagName');
        const classes = $el.attr('class');
        const id = $el.attr('id');
        return `${tagName}_${classes || ''}_${id || ''}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _analyzeStructure() {
        this.templateFingerprint = {
            sections: Array.from(this.sectionMap.entries()).map(([el, type]) => ({
                type,
                selector: this._generateSelector(el),
                styleId: this._generateStyleId(el)
            })),
            listStyles: this._analyzeListStyles(),
            bulletStyles: this._analyzeBulletStyles()
        };
    }

    _generateSelector(element) {
        const $el = this.$(element);
        const id = $el.attr('id');
        if (id) return `#${id}`;
        
        const classes = $el.attr('class');
        if (classes) {
            return `.${classes.split(/\s+/).join('.')}`;
        }
        
        return this._generateStructuralSelector($el);
    }

    _generateStructuralSelector($el) {
        const path = [];
        let current = $el;
        while (current.length && !current.is('body')) {
            let selector = current.prop('tagName').toLowerCase();
            const id = current.attr('id');
            const classes = current.attr('class');
            
            if (id) {
                selector += `#${id}`;
            } else if (classes) {
                selector += `.${classes.split(/\s+/).join('.')}`;
            } else {
                const index = current.index() + 1;
                if (index > 1) {
                    selector += `:nth-child(${index})`;
                }
            }
            
            path.unshift(selector);
            current = current.parent();
        }
        return path.join(' > ');
    }

    _analyzeListStyles() {
        const listStyles = new Map();
        this.$('ul, ol').each((_, el) => {
            const $list = this.$(el);
            const styleId = this._generateStyleId(el);
            listStyles.set(styleId, {
                type: $list.prop('tagName').toLowerCase(),
                style: $list.attr('style') || '',
                class: $list.attr('class') || '',
                selector: this._generateSelector($list)
            });
        });
        return listStyles;
    }

    _analyzeBulletStyles() {
        const bulletStyles = new Map();
        this.$('li').each((_, el) => {
            const $bullet = this.$(el);
            const styleId = this._generateStyleId(el);
            bulletStyles.set(styleId, {
                style: $bullet.attr('style') || '',
                class: $bullet.attr('class') || '',
                selector: this._generateSelector($bullet)
            });
        });
        return bulletStyles;
    }
}

class DynamicBulletManager {
    constructor(templateAnalyzer) {
        this.analyzer = templateAnalyzer;
        this.$ = templateAnalyzer.$;
        this.bulletStyles = new Map();
        this.originalBullets = new Map();
    }

    extractExistingBullets() {
        const bullets = new Map();
        
        this.analyzer.sectionMap.forEach(($section, sectionType) => {
            const sectionBullets = [];
            
            // Find all list items within the section
            $section.find('li, .bullet, [class*="bullet"], [class*="point"]').each((_, el) => {
                const $bullet = this.$(el);
                const bulletText = $bullet.text().trim();
                
                if (bulletText) {
                    // Store the original styling
                    this.bulletStyles.set(bulletText, {
                        element: el,
                        style: $bullet.attr('style') || '',
                        class: $bullet.attr('class') || '',
                        parentList: {
                            type: $bullet.parent().prop('tagName')?.toLowerCase() || 'ul',
                            style: $bullet.parent().attr('style') || '',
                            class: $bullet.parent().attr('class') || ''
                        }
                    });
                    
                    sectionBullets.push(bulletText);
                }
            });
            
            if (sectionBullets.length > 0) {
                bullets.set(sectionType, sectionBullets);
            }
        });
        
        this.originalBullets = bullets;
        return bullets;
    }

    findOrCreateBulletList($section) {
        // Try to find existing list
        let $list = $section.find('ul, ol').first();
        
        if (!$list.length) {
            // Try to find a common parent for bullet-like elements
            $list = $section.find('[class*="bullet"], [class*="point"]').parent();
        }
        
        if (!$list.length) {
            // Create new list with styling based on template analysis
            const listStyles = this.analyzer.templateFingerprint.listStyles;
            const defaultStyle = listStyles.size > 0 ? 
                Array.from(listStyles.values())[0] : 
                { type: 'ul', style: '', class: '' };
            
            $list = this.$(`<${defaultStyle.type}></${defaultStyle.type}>`);
            if (defaultStyle.style) $list.attr('style', defaultStyle.style);
            if (defaultStyle.class) $list.attr('class', defaultStyle.class);
            
            // Find best position to insert the list
            const $lastHeading = $section.find('h1, h2, h3, h4, h5, h6').last();
            if ($lastHeading.length) {
                $lastHeading.after($list);
            } else {
                $section.append($list);
            }
        }
        
        return $list;
    }

    addBulletToSection(bulletText, $section, preserveStyle = true) {
        const $list = this.findOrCreateBulletList($section);
        
        // Create the new bullet point
        let $bullet;
        if (preserveStyle && this.bulletStyles.has(bulletText)) {
            // Use original styling if available
            const style = this.bulletStyles.get(bulletText);
            $bullet = this.$('<li></li>')
                .html(bulletText)
                .attr('style', style.style)
                .attr('class', style.class);
        } else {
            // Use template's default bullet styling
            const bulletStyles = this.analyzer.templateFingerprint.bulletStyles;
            const defaultStyle = bulletStyles.size > 0 ?
                Array.from(bulletStyles.values())[0] :
                { style: '', class: '' };
            
            $bullet = this.$('<li></li>')
                .html(bulletText)
                .attr('style', defaultStyle.style)
                .attr('class', defaultStyle.class);
        }
        
        $list.append($bullet);
        return $bullet;
    }

    replaceBullets(sectionType, newBullets) {
        const $section = this.analyzer.sectionMap.get(sectionType);
        if (!$section) return false;
        
        // Clear existing bullets
        $section.find('li, .bullet, [class*="bullet"], [class*="point"]').remove();
        
        // Add new bullets
        newBullets.forEach(bullet => {
            this.addBulletToSection(bullet, $section);
        });
        
        return true;
    }

    updateBulletContent(oldBullet, newContent) {
        const style = this.bulletStyles.get(oldBullet);
        if (!style) return false;
        
        const $bullet = this.$(style.element);
        if (!$bullet.length) return false;
        
        $bullet.html(newContent);
        this.bulletStyles.set(newContent, style);
        this.bulletStyles.delete(oldBullet);
        
        return true;
    }
}

function countWordsInBullet(text) {
    const cleaned = text.trim()
        .replace(/[""]/g, '') // Remove smart quotes
        .replace(/[.,!?()]/g, '') // Remove punctuation
        .replace(/\s+/g, ' '); // Normalize spaces
    
    const words = cleaned.split(' ')
        .filter(word => word.length > 0)
        .map(word => word.replace(/-/g, '')); // Treat hyphenated words as single
        
    return words.length;
}

function getSectionWordCounts($) {
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    $('.job-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.job.total += wordCount;
        counts.job.bullets++;
    });

    $('.project-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.project.total += wordCount;
        counts.project.bullets++;
    });

    $('.education-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.education.total += wordCount;
        counts.education.bullets++;
    });

    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15,
        education: counts.education.bullets > 0 ? Math.round(counts.education.total / counts.education.bullets) : 15
    };
}

// Add new function to extract and store original bullets
function extractOriginalBullets($) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: [] // For any bullets not in a specific section
    };

    $('.job-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.job.includes(bulletText)) {
                originalBullets.job.push(bulletText);
            }
        });
    });

    $('.project-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.project.includes(bulletText)) {
                originalBullets.project.push(bulletText);
            }
        });
    });

    $('.education-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.education.includes(bulletText)) {
                originalBullets.education.push(bulletText);
            }
        });
    });

    return originalBullets;
}

// Add new class to track section-specific bullets
class SectionBulletTracker {
    constructor() {
        this.bulletMap = new Map(); // Maps bullet text to section type
        this.usedBullets = new Set(); // Tracks all used bullets
    }

    addBullet(bulletText, sectionType) {
        this.bulletMap.set(bulletText, sectionType);
        this.usedBullets.add(bulletText);
    }

    canUseBulletInSection(bulletText, sectionType) {
        if (!this.bulletMap.has(bulletText)) return true;
        return this.bulletMap.get(bulletText) === sectionType;
    }

    isUsed(bulletText) {
        return this.usedBullets.has(bulletText);
    }
}

// Improve the ActionVerbTracker class to be more effective at preventing duplicate verbs
class ActionVerbTracker {
    constructor() {
        this.usedVerbs = new Map(); // Maps section type to Set of used verbs
        this.globalVerbs = new Set(); // Tracks verbs used across all sections
        this.verbSynonyms = new Map(); // Maps common verbs to their usage count
    }

    addVerb(verb, sectionType) {
        verb = verb.toLowerCase().trim();
        
        if (!verb || !verb.match(/^[a-z]+$/)) return;
        
        if (!this.usedVerbs.has(sectionType)) {
            this.usedVerbs.set(sectionType, new Set());
        }
        this.usedVerbs.get(sectionType).add(verb);
        this.globalVerbs.add(verb);
        
        if (!this.verbSynonyms.has(verb)) {
            this.verbSynonyms.set(verb, 1);
        } else {
            this.verbSynonyms.set(verb, this.verbSynonyms.get(verb) + 1);
        }
    }

    isVerbUsedInSection(verb, sectionType) {
        verb = verb.toLowerCase().trim();
        return this.usedVerbs.get(sectionType)?.has(verb) || false;
    }

    isVerbUsedGlobally(verb) {
        verb = verb.toLowerCase().trim();
        return this.globalVerbs.has(verb);
    }

    getUsedVerbs() {
        return Array.from(this.globalVerbs);
    }

    getMostUsedVerbs(limit = 10) {
        return Array.from(this.verbSynonyms.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(entry => entry[0]);
    }

    clearSection(sectionType) {
        this.usedVerbs.set(sectionType, new Set());
    }
}

// Add function to get first verb from bullet point
function getFirstVerb(bulletText) {
    return bulletText.trim().split(/\s+/)[0].toLowerCase();
}

// Update the generateBullets function to emphasize verb diversity
async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    const basePrompt = `You are a specialized resume bullet point optimizer. Engage in chain-of-thought reasoning: before generating or enhancing resume bullets, think out loud—reflect step by step on the user's input, context, and keywords, justifying each keyword and technology choice to ensure coherent, ATS-friendly, and relevant results. Avoid illogical pairings (e.g., Apex with Java). After your chain-of-thought, generate or enhance resume bullets following these strict rules:

FORMATTING RULES:
1. Every bullet MUST start with '>>' (no space after)
2. One specific metric per bullet (%, $, time, or quantity)
3. Each bullet MUST begin with a strong action verb
4. NEVER reuse the same starting verb across bullet points
5. Each bullet MUST be ${wordLimit} words or less

KEYWORD INTEGRATION RULES:
1. Use keywords from this list: ${keywords}
2. Use ONLY 1-2 related technologies per bullet
3. NEVER combine unrelated technologies in the same bullet point
4. Each keyword MUST be used at least once across all bullets
5. If a technology doesn't fit naturally, preserve the achievement and remove ALL tech references

TECHNOLOGY COMBINATION RULES:
1. Keep technologies within their domain (frontend, backend, etc.)
2. Frontend tools stay with frontend (e.g., React with CSS)
3. Backend tools stay with backend (e.g., Node.js with MongoDB)
4. Database operations stay with database tools
5. NEVER mix frontend tools with backend/database operations

EXAMPLES OF PROPER TECHNOLOGY INTEGRATION:

GOOD (Related Technologies):
>>Developed React components with CSS animations, reducing page load time by 40%
>>Implemented Python data processing pipeline using PostgreSQL, handling 1M daily records
>>Optimized Node.js API endpoints with Redis caching, supporting 50K daily users

BAD (Unrelated Technologies):
>>Used React to optimize PostgreSQL queries (Frontend tool for database tasks)
>>Implemented Python in React components (Mixing unrelated languages)
>>Built MongoDB interface using CSS Grid (Database tasks with styling tools)

ACTION VERB GUIDELINES:
Approved Verbs:
- Performance: Improved, Increased, Reduced, Decreased, Optimized
- Development: Developed, Designed, Implemented, Created, Launched
- Leadership: Led, Directed, Coordinated, Managed
- Analysis: Analyzed, Evaluated, Solved

Prohibited Verbs:
- Weak: Built, Helped, Used, Worked
- Complex: Orchestrated, Spearheaded, Piloted
- Grandiose: Revolutionized, Transformed, Pioneered

METRICS GUIDELINES:
1. Keep all existing numbers EXACTLY as provided
2. Each bullet MUST include ONE specific metric:
   - Percentages (e.g., "reduced costs by 40%")
   - Time (e.g., "decreased load time by 2.5 seconds")
   - Quantity (e.g., "supported 100K users")
   - Money (e.g., "saved $50K annually")

INPUT TO ENHANCE:
${(existingBullets || []).join('\n')}`;

    const prompt = mode === 'tailor' 
        ? `${basePrompt}\n\nTASK: Enhance the above bullets by naturally integrating the provided keywords. Maintain original metrics and achievements.`
        : `${basePrompt}\n\nTASK: Generate 15 achievement-focused bullets ${context} with concrete metrics and varied action verbs.`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized resume bullet point optimizer. First, think out loud: analyze the user's input, context, and keyword list step by step, reflecting on which keywords and technologies should be included or omitted, and justify each decision to ensure logical, ATS-friendly, and relevant results. Avoid illogical pairings (e.g., Apex with Java). After your chain-of-thought, generate or enhance resume bullets following these STRICT rules:\n1. Every bullet MUST start with '>>' (no space)\n2. Use ONLY related technologies together\n3. Use each provided keyword at least once\n4. Include ONE specific metric per bullet\n5. Use ONLY approved action verbs\n6. Never exceed word limit\n7. Never mix unrelated technologies\n8. Focus on concrete achievements"
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.5,
                max_tokens: 4096,
                top_p: 1
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );

        const content = response.data.choices[0].message.content;
        
        // Extract bullets that start with ">>"
        let bullets = content.match(/^\>\>(.+)$/gm) || [];
        
        // If we don't have enough bullets, try to extract complete sentences
        if (bullets.length < 3) {
            const additionalBullets = content.split(/\n+/)
                .filter(line => {
                    const trimmed = line.trim();
                    return trimmed.length > 30 && 
                           /^[A-Z]/.test(trimmed) && 
                           /\d+/.test(trimmed);
                })
                .map(b => `>>${b}`);
            
            bullets = [...bullets, ...additionalBullets];
        }
        
        // Clean and format bullets
        return bullets.map(bullet => 
            bullet.replace(/^>>\s*/, '')
                  .replace(/\*\*/g, '')
                  .replace(/\s*\([^)]*\)$/, '')
        );
    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return [];
    }
}

// Add function to shuffle bullets with verb checking
function shuffleBulletsWithVerbCheck(bullets, sectionType, verbTracker) {
    let attempts = 0;
    const maxAttempts = 15;
    
    while (attempts < maxAttempts) {
        bullets = shuffleArray([...bullets]);
        
        let isValid = true;
        let previousVerbs = new Set();
        
        for (let i = 0; i < bullets.length; i++) {
            const currentVerb = getFirstVerb(bullets[i]);
            
            // Skip empty bullets
            if (!currentVerb) continue;
            
            // Check if verb is same as any previous bullet or already used as first verb globally
            if (previousVerbs.has(currentVerb) || 
                (verbTracker.isVerbUsedGlobally(currentVerb) && i === 0)) {
                isValid = false;
                break;
            }
            
            previousVerbs.add(currentVerb);
        }
        
        if (isValid) {
            // Add first verb to tracker
            if (bullets.length > 0) {
                verbTracker.addVerb(getFirstVerb(bullets[0]), sectionType);
            }
            return bullets;
        }
        
        attempts++;
    }
    
    const sortedBullets = [...bullets].sort((a, b) => {
        const verbA = getFirstVerb(a);
        const verbB = getFirstVerb(b);
        
        if (!verbTracker.isVerbUsedGlobally(verbA) && verbTracker.isVerbUsedGlobally(verbB)) {
            return -1;
        }
        if (verbTracker.isVerbUsedGlobally(verbA) && !verbTracker.isVerbUsedGlobally(verbB)) {
            return 1;
        }
        return 0;
    });
    
    if (sortedBullets.length > 0) {
        verbTracker.addVerb(getFirstVerb(sortedBullets[0]), sectionType);
    }
    
    return sortedBullets;
}

// Add BulletCache class for efficient bullet point management
class BulletCache {
    constructor() {
        this.cache = new Map();
        this.sectionPools = {
            job: new Set(),
            project: new Set(),
            education: new Set()
        };
        this.targetBulletCounts = {
            job: 7,
            project: 6,
            education: 5
        };
    }

    async generateAllBullets($, keywords, context, wordLimit, verbTracker) {
        const sections = ['job', 'project', 'education'];
        const cacheKey = `${keywords.join(',')}_${context}`;

        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        const allBullets = {};
        const promises = sections.map(async (section) => {
            const targetCount = this.targetBulletCounts[section];
            const bullets = await generateBullets(
                'generate',
                null,
                keywords,
                `for ${section} experience`,
                wordLimit,
                verbTracker
            );
            allBullets[section] = bullets.slice(0, targetCount);
            bullets.forEach(bullet => this.sectionPools[section].add(bullet));
        });

        await Promise.all(promises);
        this.cache.set(cacheKey, allBullets);
        return allBullets;
    }

    getBulletsForSection(section, count) {
        return Array.from(this.sectionPools[section]).slice(0, count);
    }

    addBulletToSection(bullet, section) {
        if (bullet && bullet.trim().length > 0) {
            this.sectionPools[section].add(bullet);
        }
    }

    clear() {
        this.cache.clear();
        Object.values(this.sectionPools).forEach(pool => pool.clear());
    }
}

async function updateResume(htmlContent, keywords, fullTailoring) {
    // Initialize template analyzer
    const templateAnalyzer = new ResumeTemplateAnalyzer(htmlContent);
    const analysis = templateAnalyzer.analyzeTemplate();
    
    // Initialize bullet manager
    const bulletManager = new DynamicBulletManager(templateAnalyzer);
    const originalBullets = bulletManager.extractExistingBullets();
    
    // Initialize other utilities
    const $ = templateAnalyzer.$;
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    
    // Update the skills section with keywords
    await updateSkillsSection($, keywords);
    
    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;
    
    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate all bullets upfront
    const allBullets = await bulletCache.generateAllBullets($, keywords, 'resume section', 15, verbTracker);

    // Map section types to our internal types
    const sectionTypeMap = {
        'experience': 'job',
        'projects': 'project',
        'education': 'education'
    };

    // Process each section
    for (const [sectionType, $section] of templateAnalyzer.sectionMap.entries()) {
        const internalType = sectionTypeMap[sectionType] || sectionType;
        if (!internalType) continue;

        const existingBullets = originalBullets.get(sectionType) || [];
        let newBullets;

        if (fullTailoring && existingBullets.length > 0) {
            // Generate tailored bullets based on existing content
            newBullets = await generateBullets(
                'tailor',
                existingBullets,
                keywords,
                `for ${sectionType}`,
                15,
                verbTracker
            );
        } else {
            // Get cached bullets for this section
            newBullets = bulletCache.getBulletsForSection(internalType, INITIAL_BULLET_COUNT);
        }

        // Filter and shuffle bullets
        newBullets = shuffleBulletsWithVerbCheck(
            newBullets.filter(bullet => !bulletManager.bulletStyles.has(bullet) || 
                                      bulletManager.bulletStyles.get(bullet).sectionType === sectionType),
            sectionType,
            verbTracker
        );

        // Replace bullets in the section
        bulletManager.replaceBullets(sectionType, newBullets.slice(0, INITIAL_BULLET_COUNT));
    }

    // Check and adjust page length
    let currentBulletCount = INITIAL_BULLET_COUNT;
    let attempts = 0;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;

        // Reduce bullets proportionally
        currentBulletCount--;
        
        for (const [sectionType, $section] of templateAnalyzer.sectionMap.entries()) {
            const internalType = sectionTypeMap[sectionType] || sectionType;
            if (!internalType) continue;

            const adjustedCount = Math.max(
                MIN_BULLETS,
                Math.floor(currentBulletCount * (sectionType === 'experience' ? 1 : 0.8))
            );

            const newBullets = bulletCache.getBulletsForSection(internalType, adjustedCount);
            bulletManager.replaceBullets(sectionType, newBullets);
        }
        
        attempts++;
    }

    return $.html();
}

async function customizeResume(req, res) {
    try {
        const { htmlContent, keywords, fullTailoring } = req.body;

        if (!htmlContent || !Array.isArray(keywords)) {
            return res.status(400).send('Invalid input: HTML content and keywords array are required');
        }

        console.log('Received keywords:', keywords);
        console.log('Full tailoring enabled:', fullTailoring);

        // Validate HTML content
        if (htmlContent.length < 100) {
            return res.status(400).send('Invalid HTML content: Content too short');
        }

        try {
            const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
            
            // Initialize template analyzer for final validation
            const templateAnalyzer = new ResumeTemplateAnalyzer(updatedHtmlContent);
            const analysis = templateAnalyzer.analyzeTemplate();
            
            // Verify that we have at least one section
            if (templateAnalyzer.sectionMap.size === 0) {
                throw new Error('No resume sections were detected in the processed document');
            }
            
            // Count bullets in each section for logging
            const bulletCounts = {};
            templateAnalyzer.sectionMap.forEach(($section, sectionType) => {
                bulletCounts[sectionType] = $section.find('li, .bullet, [class*="bullet"], [class*="point"]').length;
            });
            
            console.log('Final bullet counts by section:', bulletCounts);
            
            const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

            if (exceedsOnePage) {
                console.warn('Warning: Resume still exceeds one page after adjustments');
            }

            res.contentType('application/pdf');
            res.set('Content-Disposition', 'attachment; filename=resume.pdf');
            res.send(Buffer.from(pdfBuffer));

        } catch (processingError) {
            console.error('Error during resume processing:', processingError);
            
            // Determine if this is a template analysis error
            if (processingError.message.includes('section')) {
                return res.status(422).send('Unable to process resume template: ' + processingError.message);
            }
            
            // Handle other processing errors
            return res.status(500).send('Error processing resume: ' + processingError.message);
        }

    } catch (error) {
        console.error('Critical error in customizeResume:', error);
        res.status(500).send('Internal server error while processing resume');
    }
}

async function convertHtmlToPdf(htmlContent) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Set default page size and margins
    await page.setContent(htmlContent, {
        waitUntil: ['domcontentloaded', 'networkidle0']
    });

    // Add minimal default styles only if no styles are present
    await page.evaluate(() => {
        if (!document.querySelector('style') && !document.querySelector('link[rel="stylesheet"]')) {
            const defaultStyle = document.createElement('style');
            defaultStyle.textContent = `
                @page {
                    size: Letter;
                    margin: 0.25in;
                }
                body {
                    font-family: system-ui, -apple-system, sans-serif;
                    line-height: 1.15;
                    margin: 0;
                    padding: 0;
                }
            `;
            document.head.appendChild(defaultStyle);
        }
    });

    // Check page height
    const height = await checkPageHeight(page);
    const MAX_HEIGHT = 1056; // 11 inches * 96 DPI
    
    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
            top: '0.25in',
            right: '0.25in',
            bottom: '0.25in',
            left: '0.25in'
        }
    });

    await browser.close();
    return { pdfBuffer, exceedsOnePage: height > MAX_HEIGHT };
}

module.exports = { customizeResume };