const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for OpenAI
const openaiApiKey = process.env.OPENAI_API_KEY;
const lmCache = new Map();

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
    const analyzer = new ResumeStructureAnalyzer($).analyze();
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    // Process job sections
    analyzer.getJobSections().forEach(section => {
        section.find('li, div.bullet, .bullet-point, p.bullet').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.job.total += wordCount;
            counts.job.bullets++;
        });
    });

    // Process project sections
    analyzer.getProjectSections().forEach(section => {
        section.find('li, div.bullet, .bullet-point, p.bullet').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.project.total += wordCount;
            counts.project.bullets++;
        });
    });

    // Process education sections
    analyzer.getEducationSections().forEach(section => {
        section.find('li, div.bullet, .bullet-point, p.bullet').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.education.total += wordCount;
            counts.education.bullets++;
        });
    });

    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15,
        education: counts.education.bullets > 0 ? Math.round(counts.education.total / counts.education.bullets) : 15
    };
}

// Add new function to extract and store original bullets
function extractOriginalBullets($) {
    const analyzer = new ResumeStructureAnalyzer($).analyze();
    return analyzer.extractBullets();
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

// Add a new class to intelligently identify resume sections
class ResumeStructureAnalyzer {
    constructor($) {
        this.$ = $;
        this.sections = {
            job: [],
            project: [],
            education: [],
            skills: null
        };
        this.sectionHeaders = {
            job: ['experience', 'work experience', 'employment', 'professional experience', 'work history'],
            project: ['projects', 'project experience', 'technical projects', 'personal projects'],
            education: ['education', 'academic background', 'educational background', 'academic experience'],
            skills: ['skills', 'technical skills', 'core competencies', 'competencies', 'technical competencies']
        };
        this.bulletContainers = new Set(['ul', 'ol', 'div.bullets', '.bullet-points', '.bullet-list']);
        this.preservedStyles = new Map();
    }

    analyze() {
        this.detectSections();
        this.extractStyles();
        return this;
    }

    detectSections() {
        // Find section headers
        this.$('h1, h2, h3, h4, h5, h6, .section-header, .section-heading, [class*="header"], [class*="heading"], [class*="title"]').each((_, header) => {
            const headerText = this.$(header).text().trim().toLowerCase();
            const headerType = this.classifySectionHeader(headerText);
            
            if (headerType) {
                const section = this.findSectionContainer(header);
                if (section) {
                    this.sections[headerType].push(section);
                }
            }
        });

        // Fallback detection for sections without clear headers
        if (this.sections.job.length === 0) {
            this.findSectionsByContent('job');
        }
        if (this.sections.project.length === 0) {
            this.findSectionsByContent('project');
        }
        if (this.sections.education.length === 0) {
            this.findSectionsByContent('education');
        }
        if (!this.sections.skills) {
            this.findSkillsSection();
        }

        console.log(`Detected sections: Jobs=${this.sections.job.length}, Projects=${this.sections.project.length}, Education=${this.sections.education.length}, Skills=${this.sections.skills ? 'Yes' : 'No'}`);
    }

    classifySectionHeader(headerText) {
        for (const [type, keywords] of Object.entries(this.sectionHeaders)) {
            if (keywords.some(keyword => headerText.includes(keyword))) {
                return type;
            }
        }
        return null;
    }

    findSectionContainer(header) {
        const headerElement = this.$(header);
        
        // Check for parent section element
        let section = headerElement.closest('section, div[class*="section"], [class*="experience"], [class*="container"]');
        if (section.length > 0) return section;
        
        // Check for next sibling container
        let nextContainer = headerElement.next('div, section, ul, ol, .content');
        if (nextContainer.length > 0) return nextContainer;
        
        // Check for container that holds both the header and content
        let parentContainer = headerElement.parent();
        if (parentContainer.children().length > 1) return parentContainer;
        
        // Fallback: Get elements until the next header
        let elements = [];
        let currentElement = headerElement.next();
        
        while (currentElement.length > 0) {
            if (currentElement.is('h1, h2, h3, h4, h5, h6, .section-header, .section-heading')) {
                break;
            }
            elements.push(currentElement[0]);
            currentElement = currentElement.next();
        }
        
        if (elements.length > 0) {
            // Create a wrapper for these elements
            const wrapper = this.$('<div class="detected-section"></div>');
            this.$(elements).wrapAll(wrapper);
            return wrapper;
        }
        
        return null;
    }

    findSectionsByContent(sectionType) {
        // Job sections often contain company names, dates, and positions
        if (sectionType === 'job') {
            this.$('div, section').each((_, element) => {
                const el = this.$(element);
                const text = el.text().toLowerCase();
                
                // Look for patterns indicating job experience
                const hasJobIndicators = /(20\d\d|present|current|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec).*?-.*?(20\d\d|present|current)/.test(text) && 
                                        /engineer|developer|analyst|manager|director|lead|architect/.test(text);
                
                if (hasJobIndicators && this.hasBulletPoints(el)) {
                    this.sections.job.push(el);
                }
            });
        }
        
        // Project sections often mention technologies and have bullet points
        else if (sectionType === 'project') {
            this.$('div, section').each((_, element) => {
                const el = this.$(element);
                const text = el.text().toLowerCase();
                
                // Look for patterns indicating projects
                const hasProjectIndicators = /project|application|app|system|website|platform|tool/.test(text) &&
                                           !this.sections.job.some(job => job.is(el));
                
                if (hasProjectIndicators && this.hasBulletPoints(el)) {
                    this.sections.project.push(el);
                }
            });
        }
        
        // Education sections often contain degrees, universities, and dates
        else if (sectionType === 'education') {
            this.$('div, section').each((_, element) => {
                const el = this.$(element);
                const text = el.text().toLowerCase();
                
                // Look for patterns indicating education
                const hasEducationIndicators = /(university|college|school|institute|academy|bachelor|master|phd|degree|diploma|certificate)/.test(text) &&
                                             /20\d\d|gpa|grade/.test(text);
                
                if (hasEducationIndicators) {
                    this.sections.education.push(el);
                }
            });
        }
    }

    findSkillsSection() {
        // Find skills section by common structures - often paragraphs or lists with technical terms
        this.$('div, section').each((_, element) => {
            const el = this.$(element);
            const text = el.text().toLowerCase();
            
            if (this.sectionHeaders.skills.some(keyword => text.includes(keyword))) {
                // Check if it looks like a skills section (contains technical terms)
                const hasTechnicalTerms = /(java|python|javascript|html|css|react|angular|node|aws|azure|sql|nosql|git|docker)/.test(text);
                
                if (hasTechnicalTerms) {
                    this.sections.skills = el;
                    return false; // Break the loop
                }
            }
        });
    }

    hasBulletPoints(element) {
        // Check if the element contains bullet point structures
        return this.bulletContainers.size > 0 && 
               Array.from(this.bulletContainers).some(selector => element.find(selector).length > 0) ||
               element.find('li').length > 0 ||
               /•|\*|✓|→|▶|★|☑|–|-/.test(element.html());
    }

    extractStyles() {
        // Store original styles to preserve them
        this.$('*').each((_, element) => {
            const el = this.$(element);
            const style = el.attr('style');
            const classAttr = el.attr('class');
            
            if (style || classAttr) {
                this.preservedStyles.set(element, {
                    style: style || '',
                    class: classAttr || ''
                });
            }
        });
    }

    findOrCreateBulletList(section) {
        // Try to find existing bullet list
        let bulletList = null;
        
        // Check each potential bullet container
        for (const selector of this.bulletContainers) {
            const found = section.find(selector);
            if (found.length > 0) {
                bulletList = found.first();
                break;
            }
        }
        
        // If no bullet list found, look for li elements directly
        if (!bulletList && section.find('li').length > 0) {
            bulletList = section.find('li').first().parent();
        }
        
        // Create a new bullet list if none found
        if (!bulletList) {
            section.append('<ul class="dynamic-bullets"></ul>');
            bulletList = section.find('.dynamic-bullets');
        }
        
        return bulletList;
    }

    applyPreservedStyles(element) {
        if (this.preservedStyles.has(element[0])) {
            const styles = this.preservedStyles.get(element[0]);
            if (styles.style) element.attr('style', styles.style);
            if (styles.class) element.attr('class', styles.class);
        }
    }

    getJobSections() {
        return this.sections.job;
    }

    getProjectSections() {
        return this.sections.project;
    }

    getEducationSections() {
        return this.sections.education;
    }

    getSkillsSection() {
        return this.sections.skills;
    }

    extractBullets() {
        const bullets = {
            job: [],
            project: [],
            education: [],
            unassigned: []
        };

        // Extract bullets from each section type
        this.sections.job.forEach(section => {
            this.extractBulletsFromSection(section, bullets.job);
        });
        
        this.sections.project.forEach(section => {
            this.extractBulletsFromSection(section, bullets.project);
        });
        
        this.sections.education.forEach(section => {
            this.extractBulletsFromSection(section, bullets.education);
        });

        return bullets;
    }

    extractBulletsFromSection(section, targetArray) {
        // Look for bullet points in various formats
        section.find('li, div.bullet, .bullet-point, p.bullet').each((_, bullet) => {
            const bulletText = this.$(bullet).text().trim();
            if (bulletText && !targetArray.includes(bulletText)) {
                targetArray.push(bulletText);
            }
        });

        // Check for text with bullet characters
        const text = section.text();
        const bulletMatches = text.match(/[•|\*|✓|→|▶|★|☑|–|-]\s*([^•|\*|✓|→|▶|★|☑|–|-]+)/g);
        if (bulletMatches) {
            bulletMatches.forEach(match => {
                const bulletText = match.replace(/^[•|\*|✓|→|▶|★|☑|–|-]\s*/, '').trim();
                if (bulletText && !targetArray.includes(bulletText)) {
                    targetArray.push(bulletText);
                }
            });
        }
    }
}

// Update function to use the analyzer instead of hard-coded selectors
function extractOriginalBullets($) {
    const analyzer = new ResumeStructureAnalyzer($).analyze();
    return analyzer.extractBullets();
}

// Update getSectionWordCounts to use the analyzer
function getSectionWordCounts($) {
    const analyzer = new ResumeStructureAnalyzer($).analyze();
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    // Process job sections
    analyzer.getJobSections().forEach(section => {
        section.find('li, div.bullet, .bullet-point, p.bullet').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.job.total += wordCount;
            counts.job.bullets++;
        });
    });

    // Process project sections
    analyzer.getProjectSections().forEach(section => {
        section.find('li, div.bullet, .bullet-point, p.bullet').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.project.total += wordCount;
            counts.project.bullets++;
        });
    });

    // Process education sections
    analyzer.getEducationSections().forEach(section => {
        section.find('li, div.bullet, .bullet-point, p.bullet').each((_, el) => {
            const wordCount = countWordsInBullet($(el).text());
            counts.education.total += wordCount;
            counts.education.bullets++;
        });
    });

    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15,
        education: counts.education.bullets > 0 ? Math.round(counts.education.total / counts.education.bullets) : 15
    };
}

// Update the updateSkillsSection function to use the analyzer
function updateSkillsSection($, keywords) {
    return new Promise(async (resolve, reject) => {
        try {
            const categorizedKeywords = await categorizeKeywords(keywords);
            if (!categorizedKeywords) {
                console.warn('Could not categorize keywords, skills section unchanged');
                resolve($);
                return;
            }
            
            const analyzer = new ResumeStructureAnalyzer($).analyze();
            const skillsSection = analyzer.getSkillsSection();
            
            if (!skillsSection) {
                console.warn('Skills section not found in resume');
                resolve($);
                return;
            }
            
            const categoryMapping = {
                "Languages": "Languages:",
                "Frameworks/Libraries": "Frameworks/Libraries:",
                "Others": "Others (APIs, Services, Protocols):",
                "Machine Learning Libraries": "Machine Learning Libraries:"
            };
            
            // Try to find existing paragraphs by text content first
            let paragraphsUpdated = false;
            
            Object.entries(categoryMapping).forEach(([dataKey, htmlLabel]) => {
                if (categorizedKeywords[dataKey] && categorizedKeywords[dataKey].length > 0) {
                    const keywords = categorizedKeywords[dataKey].join(', ');
                    
                    // Look for paragraphs with this label
                    let foundParagraph = false;
                    skillsSection.find('p, div, span').each((_, el) => {
                        const element = $(el);
                        if (element.text().toLowerCase().includes(htmlLabel.toLowerCase())) {
                            // Find the content part that should be updated
                            const html = element.html();
                            const updatedHtml = html.replace(
                                new RegExp(`(${htmlLabel})([^<]+|<[^>]+>)*`, 'i'),
                                `$1 ${keywords}`
                            );
                            element.html(updatedHtml);
                            foundParagraph = true;
                            paragraphsUpdated = true;
                            return false; // Break the loop
                        }
                    });
                    
                    if (!foundParagraph) {
                        // Create new paragraph with proper styling if needed
                        const existingParagraph = skillsSection.find('p, div span').first();
                        const newParagraph = $(`<p><strong>${htmlLabel}</strong> ${keywords}</p>`);
                        
                        // Copy any styling from existing paragraphs
                        if (existingParagraph.length) {
                            const style = existingParagraph.attr('style');
                            if (style) newParagraph.attr('style', style);
                            
                            const className = existingParagraph.attr('class');
                            if (className) newParagraph.attr('class', className);
                        }
                        
                        skillsSection.append(newParagraph);
                        paragraphsUpdated = true;
                    }
                }
            });
            
            // If we couldn't update by paragraphs, try a simple text replacement approach
            if (!paragraphsUpdated) {
                let allKeywords = [];
                Object.values(categorizedKeywords).forEach(categoryKeywords => {
                    allKeywords = [...allKeywords, ...categoryKeywords];
                });
                
                if (allKeywords.length > 0) {
                    const keywordText = allKeywords.join(', ');
                    
                    // Try to find the text content area
                    const contentElement = skillsSection.find('p, div, span').first();
                    if (contentElement.length) {
                        contentElement.text(keywordText);
                    } else {
                        skillsSection.append(`<p>${keywordText}</p>`);
                    }
                }
            }
            
            resolve($);
        } catch (error) {
            console.error('Error updating skills section:', error);
            resolve($); // Still resolve even on error
        }
    });
}

// Update the updateResumeSection function to use the analyzer
async function updateResumeSection($, sections, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker, bulletCache) {
    const analyzer = new ResumeStructureAnalyzer($);
    
    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        let bulletList = analyzer.findOrCreateBulletList(section);

        let bulletPoints = bulletCache.getBulletsForSection(sectionType, targetBulletCount);
        
        if (fullTailoring && bulletList.find('li').length > 0) {
            const existingBullets = bulletList.find('li')
                .map((_, el) => $(el).text())
                .get();
                
            bulletPoints = await generateBullets(
                'tailor', existingBullets,
                keywords, context, wordLimit, verbTracker
            );
            
            bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
        }

        bulletPoints = bulletPoints
            .filter(bp => !bulletTracker.isUsed(bp) || 
                        bulletTracker.canUseBulletInSection(bp, sectionType))
            .slice(0, targetBulletCount);

        bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, sectionType, verbTracker);

        // Preserve any styling from existing list items before emptying
        const styleSample = bulletList.find('li').first();
        let preservedStyle = '';
        let preservedClass = '';
        
        if (styleSample.length) {
            preservedStyle = styleSample.attr('style') || '';
            preservedClass = styleSample.attr('class') || '';
        }

        bulletList.empty();
        bulletPoints.forEach(point => {
            bulletTracker.addBullet(point, sectionType);
            verbTracker.addVerb(getFirstVerb(point), sectionType);
            
            const newItem = $(`<li>${point}</li>`);
            
            // Apply preserved styles
            if (preservedStyle) newItem.attr('style', preservedStyle);
            if (preservedClass) newItem.attr('class', preservedClass);
            
            bulletList.append(newItem);
        });
    }
}

// Modify adjustSectionBullets to use the analyzer
async function adjustSectionBullets($, sections, targetCount, sectionType, bulletTracker, keywords, context, bulletCache) {
    const analyzer = new ResumeStructureAnalyzer($);
    
    sections.each((_, section) => {
        const sectionEl = $(section);
        const bulletList = analyzer.findOrCreateBulletList(sectionEl);
        const bullets = bulletList.find('li');
        const currentCount = bullets.length;

        if (currentCount > targetCount) {
            // Remove excess bullets from the end
            bullets.slice(targetCount).remove();
        } else if (currentCount < targetCount) {
            const cachedBullets = bulletCache.getBulletsForSection(sectionType, targetCount - currentCount);
            const validBullets = cachedBullets
                .filter(bp => !bulletTracker.isUsed(bp))
                .slice(0, targetCount - currentCount);

            // Preserve any styling from existing list items
            const styleSample = bullets.first();
            let preservedStyle = '';
            let preservedClass = '';
            
            if (styleSample.length) {
                preservedStyle = styleSample.attr('style') || '';
                preservedClass = styleSample.attr('class') || '';
            }

            validBullets.forEach(bullet => {
                bulletTracker.addBullet(bullet, sectionType);
                
                const newItem = $(`<li>${bullet}</li>`);
                
                // Apply preserved styles
                if (preservedStyle) newItem.attr('style', preservedStyle);
                if (preservedClass) newItem.attr('class', preservedClass);
                
                bulletList.append(newItem);
            });
        }
    });
}

// Modify convertHtmlToPdf to preserve original styles
async function convertHtmlToPdf(htmlContent) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Extract any existing styles from the HTML before we add our own
    const existingStyles = await extractExistingStyles(htmlContent);

    // Base CSS that will be applied only if needed
    const baseCSS = `
        @page {
            size: Letter;
            margin: 0.25in;
        }
        body {
            font-family: 'Calibri', 'Arial', sans-serif;
            font-size: 10pt;
            line-height: 1.15;
            margin: 0;
            padding: 0;
            color: #000;
            max-width: 100%;
        }
    `;

    await page.setContent(htmlContent);

    // Only apply our styles if there are no substantial styles in the document
    if (!existingStyles.hasSubstantialStyles) {
        await page.evaluate((css) => {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }, baseCSS + existingStyles.extractedCSS);
    }

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

// New function to extract existing styles
async function extractExistingStyles(htmlContent) {
    const cheerio = require('cheerio');
    const $ = cheerio.load(htmlContent);
    
    let extractedCSS = '';
    let hasSubstantialStyles = false;
    
    // Check for style tags
    $('style').each((_, element) => {
        const styleContent = $(element).html();
        if (styleContent && styleContent.length > 100) {
            hasSubstantialStyles = true;
        }
        extractedCSS += styleContent + '\n';
    });
    
    // Check for external stylesheets
    $('link[rel="stylesheet"]').each((_, element) => {
        hasSubstantialStyles = true;
    });
    
    // Check for inline styles
    const elements = $('[style]');
    if (elements.length > 10) {
        hasSubstantialStyles = true;
    }
    
    return { extractedCSS, hasSubstantialStyles };
}

// Update the updateResume function to use the analyzer
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent, { decodeEntities: false }); // Preserve original entities
    
    // Create and analyze the resume structure
    const analyzer = new ResumeStructureAnalyzer($).analyze();
    const sectionWordCounts = getSectionWordCounts($);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    
    // Extract original bullets before any modifications
    const originalBullets = analyzer.extractBullets();
    
    // Update the skills section with keywords
    await updateSkillsSection($, keywords);
    
    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;
    
    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate all bullets upfront
    const allBullets = await bulletCache.generateAllBullets($, keywords, 'resume section', 15, verbTracker);

    // Get sections from analyzer
    const sections = [
        { selector: $(analyzer.getJobSections()), type: 'job', context: 'for a job experience', bullets: originalBullets.job },
        { selector: $(analyzer.getProjectSections()), type: 'project', context: 'for a project', bullets: originalBullets.project },
        { selector: $(analyzer.getEducationSections()), type: 'education', context: 'for education', bullets: originalBullets.education }
    ];

    // Update each section with its specific context
    for (const section of sections) {
        if (section.selector.length > 0) {
            await updateResumeSection(
                $, section.selector, keywordString, section.context,
                fullTailoring, sectionWordCounts[section.type],
                bulletTracker, section.type, section.bullets,
                INITIAL_BULLET_COUNT, verbTracker, bulletCache
            );
        }
    }

    // Check and adjust page length with smarter space management
    let currentBulletCount = INITIAL_BULLET_COUNT;
    let attempts = 0;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        const { exceedsOnePage } = await convertHtmlToPdf($.html());
        if (!exceedsOnePage) break;

        // Reduce bullets proportionally based on section importance
        currentBulletCount--;
        for (const section of sections) {
            if (section.selector.length > 0) {
                const adjustedCount = Math.max(
                    MIN_BULLETS,
                    Math.floor(currentBulletCount * (section.type === 'job' ? 1 : 0.8))
                );
                await adjustSectionBullets(
                    $, section.selector, adjustedCount,
                    section.type, bulletTracker, keywordString,
                    section.context, bulletCache
                );
            }
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

        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        
        // Load the updated content to check results
        const $ = cheerio.load(updatedHtmlContent);
        const analyzer = new ResumeStructureAnalyzer($).analyze();
        
        let jobBullets = 0;
        let projectBullets = 0;
        let educationBullets = 0;
        
        // Count bullets in each section
        analyzer.getJobSections().forEach(section => {
            jobBullets += $(section).find('li').length;
        });
        
        analyzer.getProjectSections().forEach(section => {
            projectBullets += $(section).find('li').length;
        });
        
        analyzer.getEducationSections().forEach(section => {
            educationBullets += $(section).find('li').length;
        });
        
        console.log(`Generated bullet counts: Jobs=${jobBullets}, Projects=${projectBullets}, Education=${educationBullets}`);
        
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }

        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };