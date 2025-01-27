const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { pool, initializeDatabase } = require('./db');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('./utils');

const app = express();
const port = 3000;

const deepseekApiKey = process.env.api_key; // Replace with your actual DeepSeek API key

// Add approved domains list matching the extension's external-content.js
const approvedDomains = [
    'linkedin.com/jobs',
    'indeed.com',
    'glassdoor.com',
    'monster.com',
    'careerbuilder.com',
    'ziprecruiter.com',
    'simplyhired.com',
    'flexjobs.com',
    'snagajob.com',
    'usajobs.gov',
    'idealist.org',
    'dice.com',
    'wellfound.com',
    'angel.co',
    'weworkremotely.com',
    'remote.co',
    'builtinnyc.com',
    'builtinla.com',
    'builtinchicago.com',
    'builtinaustin.com',
    'builtinboston.com',
    'builtinseattle.com',
    'builtinsf.com',
    'hired.com',
    'google.com/about/careers',
    'careers.google.com',
    'craigslist.org',
    'themuse.com',
    'theladders.com',
    'roberthalf.com',
    'kellyservices.com',
    'adecco.com',
    'randstad.com',
    'joinhandshake.com',
    'linkup.com',
    'jobvite.com',
    'github.com/jobs',
    'behance.net/jobs',
    'dribbble.com/jobs',
    'artstation.com/jobs',
    'mediabistro.com',
    'journalismjobs.com',
    'higheredjobs.com',
    'insidehighered.com/jobs',
    'schoolspring.com',
    'healthecareers.com',
    'nursingjobs.com',
    'allhealthcarejobs.com',
    'lawjobs.com',
    'ihireaccounting.com',
    'salesgravy.com',
    'energyjobline.com',
    'manufacturingjobs.com',
    'truckingtruth.com',
    'automotivecareers.com',
    'wayup.com',
    'chegg.com/internships',
    'internships.com',
    'upwork.com',
    'fiverr.com',
    'freelancer.com',
    'toptal.com',
    'peopleperhour.com',
    '99designs.com',
    'thumbtack.com',
    'taskrabbit.com',
    'guru.com',
    'collegerecruiter.com',
    'aftercollege.com',
    'job.com',
    'vault.com',
    'yello.co',
    'jobcase.com',
    'workable.com',
    'jora.com',
    'neuvoo.com',
    'careerjet.com',
    'talentzoo.com',
    'clearancejobs.com',
    'efinancialcareers.com',
    'rigzone.com',
    'coolworks.com',
    'entertainmentcareers.net',
    'productionhub.com',
    'poachedjobs.com',
    'goodfoodjobs.com',
    'starchefs.com',
    'campleaders.com',
    'k12jobspot.com',
    'localwise.com',
    'authenticjobs.com',
    'climatebase.org',
    'pocitjobs.com',
    'diversityjobs.com',
    'vetjobs.com',
    'hirepurpose.com',
    'workforce50.com',
    'retiredbrains.com',
    'aarp.org/jobs',
    'ratracerebellion.com',
    'otta.com',
    'biospace.com',
    'pdnjobs.com',
    'medreps.com',
    'cryptojobslist.com',
    'gun.io',
    '6figurejobs.com',
    'krop.com',
    'nurse.com',
    'productionbeast.com',
    'salesjobs.com',
    'techcareers.com',
    'travelnursesource.com',
    'writerswrite.com',
    'lever.co',
    'greenhouse.io',
    'workday.com',
    'bamboohr.com',
    'smartrecruiters.com'
];

// Convert domains to regex patterns that match subdomains
const domainPatterns = approvedDomains.map(domain => {
    const escaped = domain.replace(/\./g, '\\.').replace(/\*/g, '.*');
    return new RegExp(`^(https?://)?([a-zA-Z0-9-]+\\.)*${escaped}(/|$)`);
});

const EXTENSION_ID = 'cofmfaceeakbeddncoaainhnfoigljjh';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

// Enhanced CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    const approvedPatterns = approvedDomains.map(d => 
      new RegExp(`^(https?://(.*\\.)?${d.replace('.', '\\.')})(:[0-9]+)?$`)
    );

    const allowedOrigins = [
      EXTENSION_ORIGIN,
      ...approvedPatterns
    ];

    if (!origin || allowedOrigins.some(pattern => 
      typeof pattern === 'string' ? origin === pattern : pattern.test(origin)
    )) {
      callback(null, true);
    } else {
      console.log('Blocked origin:', origin);
      callback(new Error('Origin not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
  exposedHeaders: ['Content-Length'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight for all routes

app.use(bodyParser.text({ type: 'text/html' }));
app.use(bodyParser.json({ limit: '50mb' }));

// Simple in-memory cache for LLM responses
const lmCache = new Map();

function getAverageBulletPointWordCount($) {
    let totalWords = 0;
    let totalBullets = 0;
    $('li').each((_, el) => {
        const text = $(el).text().trim();
        if (text) {
            totalWords += text.split(/\s+/).length;
            totalBullets++;
        }
    });
    return totalBullets === 0 ? 15 : Math.floor(totalWords / totalBullets);
}

function countWordsInBullet(text) {
    // Remove extra whitespace and special characters
    const cleaned = text.trim()
        .replace(/[""]/g, '') // Remove smart quotes
        .replace(/[.,!?()]/g, '') // Remove punctuation
        .replace(/\s+/g, ' '); // Normalize spaces
    
    // Count hyphenated words as one word
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

    // Count job section bullets
    $('.job-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.job.total += wordCount;
        counts.job.bullets++;
    });

    // Count project section bullets
    $('.project-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.project.total += wordCount;
        counts.project.bullets++;
    });

    // Count education section bullets
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

// Remove the old functions: generateBulletPoints, generateTailoredBulletPoints, generateAllSectionBulletPoints

async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    let prompt;
    const basePrompt = `Expert resume writer: Transform bullets into compelling achievements while naturally incorporating ALL keywords.

CRITICAL REQUIREMENTS:
1) Preserve EXACT numbers, metrics, and achievements (e.g., "increased efficiency by 45%" must stay exactly as "45%")
2) Integrate ALL keywords (${keywords}) naturally into the flow
3) Maintain original actions and responsibilities
4) Each bullet starts with ">>" and uses strong action verbs
5) Keep within ${wordLimit} words unless preserving details requires more

STRUCTURE (implicit, not explicit):
- Begin with impactful action
- Weave in context naturally
- Integrate keywords smoothly
- End with quantifiable results

EXAMPLES:
Original: "Managed database optimization project"
Keywords: "Python, AWS"
✓ CORRECT: ">>Spearheaded database optimization project using Python scripts and AWS infrastructure, improving query speed by 60%"
✗ WRONG: ">>Used Python and AWS to manage databases" (lost original responsibility)
✗ WRONG: ">>Managed database project (Python, AWS)" (artificial keyword placement)

Original: "Led team of 5 developers, increased productivity 30%"
Keywords: "agile, JavaScript"
✓ CORRECT: ">>Led 5-person agile development team delivering JavaScript applications, driving 30% productivity increase"
✗ WRONG: ">>Used agile and JavaScript to increase productivity" (lost team size)

VALIDATION:
1. Verify ALL keywords appear naturally
2. Confirm ALL metrics remain unchanged
3. Ensure original achievements stay intact
4. Check for ">>" prefix`;

    if (mode === 'tailor') {
        prompt = `${basePrompt}

INPUT BULLETS TO ENHANCE (integrate ALL keywords naturally):
${(existingBullets || []).join('\n')}`;
    } else {
        prompt = `${basePrompt}

Generate 4-5 achievement-focused bullets for ${context}`;
    }

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: 'deepseek-chat',
            messages: [
                { 
                    role: 'system', 
                    content: 'You are a specialized resume optimization AI focused on seamlessly integrating keywords while preserving achievement metrics. Your primary goal is ensuring ALL keywords appear naturally in each bullet point.'
                },
                { role: 'user', content: prompt }
            ],
            temperature: 0.7, // Add some creativity while maintaining consistency
            stream: false
        }, {
            headers: {
                'Authorization': `Bearer ${deepseekApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Extract bullet points
        const content = response.data.choices[0].message.content.trim();
        const matched = content.match(/^\>\>(.+)$/gm) || [];
        return matched.map(bp =>
            bp.replace(/^>>\s*/, '')
              .replace(/\*\*/g, '')
        );
    } catch (error) {
        console.error('Error generating bullets:', error);
        throw error;
    }
}

// Add new function to extract and store original bullets
function extractOriginalBullets($) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: [] // For any bullets not in a specific section
    };

    // Extract job bullets
    $('.job-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.job.includes(bulletText)) {
                originalBullets.job.push(bulletText);
            }
        });
    });

    // Extract project bullets
    $('.project-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.project.includes(bulletText)) {
                originalBullets.project.push(bulletText);
            }
        });
    });

    // Extract education bullets
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
        // If bullet hasn't been used before, it can be used
        if (!this.bulletMap.has(bulletText)) return true;
        // If bullet has been used, only allow in same section type
        return this.bulletMap.get(bulletText) === sectionType;
    }

    isUsed(bulletText) {
        return this.usedBullets.has(bulletText);
    }
}

// Add new class to track action verbs
class ActionVerbTracker {
    constructor() {
        this.usedVerbs = new Map(); // Maps section type to Set of used verbs
        this.globalVerbs = new Set(); // Tracks verbs used across all sections
    }

    addVerb(verb, sectionType) {
        verb = verb.toLowerCase();
        if (!this.usedVerbs.has(sectionType)) {
            this.usedVerbs.set(sectionType, new Set());
        }
        this.usedVerbs.get(sectionType).add(verb);
        this.globalVerbs.add(verb);
    }

    isVerbUsedInSection(verb, sectionType) {
        verb = verb.toLowerCase();
        return this.usedVerbs.get(sectionType)?.has(verb) || false;
    }

    isVerbUsedGlobally(verb) {
        return this.globalVerbs.has(verb.toLowerCase());
    }

    clearSection(sectionType) {
        this.usedVerbs.set(sectionType, new Set());
    }
}

// Add function to get first verb from bullet point
function getFirstVerb(bulletText) {
    return bulletText.trim().split(/\s+/)[0].toLowerCase();
}

// Add function to shuffle bullets with verb checking
function shuffleBulletsWithVerbCheck(bullets, sectionType, verbTracker) {
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
        // Shuffle the array
        bullets = shuffleArray([...bullets]);
        
        // Check if the arrangement is valid
        let isValid = true;
        let previousVerb = '';
        
        for (let i = 0; i < bullets.length; i++) {
            const currentVerb = getFirstVerb(bullets[i]);
            
            // Check if verb is same as previous bullet or already used as first verb in another section
            if (currentVerb === previousVerb || 
                (i === 0 && verbTracker.isVerbUsedGlobally(currentVerb))) {
                isValid = false;
                break;
            }
            
            previousVerb = currentVerb;
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
    
    return bullets; // Return last shuffle if we couldn't find perfect arrangement
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

    async generateAllBullets($, keywords, context, wordLimit) {
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
                wordLimit
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
        this.sectionPools[section].add(bullet);
    }

    clear() {
        this.cache.clear();
        Object.values(this.sectionPools).forEach(pool => pool.clear());
    }
}

// Update updateResume function to use BulletCache
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const sectionWordCounts = getSectionWordCounts($);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    
    // Extract original bullets before any modifications
    const originalBullets = extractOriginalBullets($);
    
    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;
    
    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate all bullets upfront
    const allBullets = await bulletCache.generateAllBullets($, keywords, 'resume section', 15);

    const sections = [
        { selector: $('.job-details'), type: 'job', context: 'for a job experience', bullets: originalBullets.job },
        { selector: $('.project-details'), type: 'project', context: 'for a project', bullets: originalBullets.project },
        { selector: $('.education-details'), type: 'education', context: 'for education', bullets: originalBullets.education }
    ];

    // Update each section with its specific context
    for (const section of sections) {
        await updateResumeSection(
            $, section.selector, keywordString, section.context,
            fullTailoring, sectionWordCounts[section.type],
            bulletTracker, section.type, section.bullets,
            INITIAL_BULLET_COUNT, verbTracker, bulletCache
        );
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
        attempts++;
    }

    return $.html();
}

// Update updateResumeSection to use BulletCache
async function updateResumeSection($, sections, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker, bulletCache) {
    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        let bulletList = section.find('ul');

        if (bulletList.length === 0) {
            section.append('<ul></ul>');
            bulletList = section.find('ul');
        }

        let bulletPoints = bulletCache.getBulletsForSection(sectionType, targetBulletCount);
        
        if (fullTailoring && bulletList.find('li').length > 0) {
            const existingBullets = bulletList.find('li')
                .map((_, el) => $(el).text())
                .get();
                
            bulletPoints = await generateBullets(
                'tailor', existingBullets,
                keywords, context, wordLimit
            );
            
            // Add tailored bullets to cache
            bulletPoints.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
        }

        // Filter and shuffle bullets
        bulletPoints = bulletPoints
            .filter(bp => !bulletTracker.isUsed(bp) || 
                         bulletTracker.canUseBulletInSection(bp, sectionType))
            .slice(0, targetBulletCount);

        // Shuffle bullets with verb checking
        bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, sectionType, verbTracker);

        // Update bullet list
        bulletList.empty();
        bulletPoints.forEach(point => {
            bulletTracker.addBullet(point, sectionType);
            bulletList.append(`<li>${point}</li>`);
        });
    }
}

// Update adjustSectionBullets to use BulletCache
async function adjustSectionBullets($, selector, targetCount, sectionType, bulletTracker, keywords, context, bulletCache) {
    const sections = $(selector);
    sections.each((_, section) => {
        const bulletList = $(section).find('ul');
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

            validBullets.forEach(bullet => {
                bulletTracker.addBullet(bullet, sectionType);
                bulletList.append(`<li>${bullet}</li>`);
            });
        }
    });
}

async function ensureBulletRange(bulletPoints, usedBullets, generateFn, minCount, maxCount) {
    let attempts = 0;
    const originalBullets = [...bulletPoints];

    while (bulletPoints.length < minCount && attempts < 3) {
        const newPoints = (await generateFn()).filter(bp => !usedBullets.has(bp));
        bulletPoints = bulletPoints.concat(newPoints);
        attempts++;
    }

    // If still below minCount, use originals instead of placeholders
    while (bulletPoints.length < minCount) {
        const recycledBullet = originalBullets[bulletPoints.length % originalBullets.length];
        bulletPoints.push(recycledBullet || bulletPoints[0]); // Fallback to first bullet if needed
    }

    return bulletPoints.slice(0, maxCount);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function checkPageHeight(page) {
    return await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        return Math.max(
            body.scrollHeight,
            body.offsetHeight,
            html.clientHeight,
            html.scrollHeight,
            html.offsetHeight
        );
    });
}

async function convertHtmlToPdf(htmlContent) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    const customCSS = `
        @page {
            size: Letter;
            margin: 0.3in;
        }
        body {
            font-family: 'Calibri', 'Arial', sans-serif;
            font-size: 12px;
            line-height: 1.2;
            margin: 0;
            padding: 0;
            color: #000;
            max-width: 100%;
        }
        
        /* Header Styling */
        h1 {
            text-align: center;
            margin: 0 0 2px 0;
            font-size: 24px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #000;
        }
        
        .contact-info {
            text-align: center;
            margin-bottom: 8px;
            width: 100%;
            display: flex;
            justify-content: center;
            gap: 4px;
            align-items: center;
            color: #000;
        }
        
        /* Keep only the separator in gray */
        .contact-info > *:not(:last-child)::after {
            content: "|";
            margin-left: 4px;
            font-size: 11px;
            color: #333;
        }
        
        /* Section Styling */
        h2 {
            text-transform: uppercase;
            border-bottom: 1px solid #000;
            margin: 0 0 4px 0;
            padding: 0;
            font-size: 14px;
            font-weight: bold;
            letter-spacing: 0;
            color: #000;
        }
        
        /* Experience Section */
        .job-details, .project-details, .education-details {
            margin-bottom: 6px;
        }
        
        .position-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 1px;
            flex-wrap: nowrap;
            width: 100%;
        }
        
        .position-left {
            display: flex;
            gap: 4px;
            align-items: baseline;
            flex: 1;
        }
        
        .company-name {
            font-weight: bold;
            font-style: italic;
            margin-right: 4px;
        }
        
        .location {
            font-style: normal;
            margin-left: auto;
            padding-right: 4px;
        }
        
        /* Bullet Points */
        ul {
            margin: 0;
            padding-left: 12px;
            margin-bottom: 4px;
        }
        
        li {
            margin-bottom: 0;
            padding-left: 0;
            line-height: 1.25;
            text-align: justify;
        }
        
        /* Links */
        a {
            color: #000;
            text-decoration: none;
        }
        
        /* Date Styling */
        .date {
            font-style: italic;
            white-space: nowrap;
            min-width: fit-content;
        }
        
        /* Skills Section */
        .skills-section {
            margin-bottom: 6px;
        }
        
        .skills-section p {
            margin: 1px 0;
            line-height: 1.25;
        }
        
        /* Adjust spacing between sections */
        section {
            margin-bottom: 8px;
        }
        
        /* Project Section */
        .project-title {
            font-weight: bold;
            font-style: italic;
        }
        
        /* Education Section */
        .degree {
            font-style: italic;
        }
        
        /* Position Title */
        .position-title {
            font-style: italic;
            font-weight: normal;
        }
    `;

    await page.setContent(htmlContent);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }, customCSS);

    // Check page height
    const height = await checkPageHeight(page);
    const MAX_HEIGHT = 1056; // 11 inches * 96 DPI
    
    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
            top: '0.3in',
            right: '0.3in',
            bottom: '0.3in',
            left: '0.3in'
        }
    });

    await browser.close();
    return { pdfBuffer, exceedsOnePage: height > MAX_HEIGHT };
}

// Add new function to manage bullet points
async function adjustBulletPoints($, sections, currentBulletCount) {
    // Reduce bullets in all sections equally
    sections.forEach(section => {
        const bulletList = $(section).find('ul');
        const bullets = bulletList.find('li');
        if (bullets.length > currentBulletCount) {
            // Remove the last bullet
            bullets.last().remove();
        }
    });
    return currentBulletCount - 1;
}

app.post('/customize-resume', async (req, res) => {
    try {
        const { htmlContent, keywords, fullTailoring } = req.body;
        
        if (!htmlContent || !Array.isArray(keywords)) {
            return res.status(400).send('Invalid input: HTML content and keywords array are required');
        }

        console.log('Received keywords:', keywords);
        console.log('Full tailoring enabled:', fullTailoring);
        
        // Update resume with keywords
        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        
        // Convert to PDF
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }

        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=customized_resume.pdf');
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
});

// Initialize database on startup
initializeDatabase().catch(console.error);

// Add new endpoints
const MIN_KEYWORD_OVERLAP = 0.85; // 85% similarity

app.post('/check-job', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const hash = generateHash(text);
        const normalizedText = normalizeText(text);
        const charLength = text.length;

        // First, try exact hash match
        const [exactMatches] = await pool.execute(
            'SELECT * FROM job_descriptions WHERE content_hash = ?',
            [hash]
        );

        if (exactMatches.length > 0) {
            const keywords = exactMatches[0].keywords; // Already parsed by MySQL driver
            
            if (!Array.isArray(keywords)) {
                console.error('Non-array keywords:', keywords);
                throw new Error('Invalid keyword format');
            }

            return res.json({
                found: true,
                keywords
            });
        }

        // Check for similar length entries (±5%)
        const lengthMargin = Math.floor(charLength * 0.05);
        const [similarLengthEntries] = await pool.execute(
            'SELECT * FROM job_descriptions WHERE char_length BETWEEN ? AND ?',
            [charLength - lengthMargin, charLength + lengthMargin]
        );

        // Check for content similarity
        for (const entry of similarLengthEntries) {
            const similarity = calculateSimilarity(
                normalizedText,
                entry.normalized_text
            );

            if (similarity >= 0.85) {
                // After similarity check
                const existingKeywords = entry.keywords;
                const similarity = calculateKeywordSimilarity(existingKeywords, keywords);
                
                if (similarity >= MIN_KEYWORD_OVERLAP) {
                    return res.json({
                        found: true,
                        keywords: existingKeywords
                    });
                }
            }
        }

        // No match found
        return res.json({ found: false });

    } catch (error) {
        console.error('Error checking job description:', error);
        res.status(500).json({ 
            error: error.message.startsWith('Corrupted') 
                ? 'Server encountered invalid data - please try again' 
                : 'Internal server error' 
        });
    }
});

app.post('/store-job', async (req, res) => {
    try {
        const { text, keywords } = req.body;
        
        // Validate keywords array
        if (!Array.isArray(keywords) || keywords.length < 3) {
            return res.status(400).json({ 
                error: 'Invalid keywords - must contain at least 3 items' 
            });
        }

        // Clean keywords before storage
        const cleanKeywords = [...new Set(keywords)] // Remove duplicates
            .filter(k => k.length >= 3) // Minimum length
            .slice(0, 25); // Maximum keywords

        const hash = generateHash(text);
        const normalizedText = normalizeText(text);
        const charLength = text.length;

        // Validate JSON structure
        try {
            if (!Array.isArray(cleanKeywords)) {
                throw new Error('Keywords must be an array');
            }
        } catch (e) {
            return res.status(400).json({ error: 'Invalid keyword format' });
        }

        // Check if exact hash already exists
        const [existing] = await pool.execute(
            'SELECT id FROM job_descriptions WHERE content_hash = ?',
            [hash]
        );

        if (existing.length > 0) {
            // Update existing entry
            await pool.execute(
                `UPDATE job_descriptions 
                SET keywords = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE content_hash = ?`,
                [JSON.stringify(cleanKeywords), hash]
            );
        } else {
            // Insert new entry
            await pool.execute(
                `INSERT INTO job_descriptions 
                (content_hash, full_text, keywords, char_length, normalized_text) 
                VALUES (?, ?, ?, ?, ?)`,
                [hash, text, JSON.stringify(cleanKeywords), charLength, normalizedText]
            );
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Error storing job description:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
