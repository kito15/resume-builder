const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

const openaiApiKey = process.env.OPENAI_API_KEY;

function countWordsInBullet(text) {
    const cleaned = text.trim()
        .replace(/["\"]/g, '')
        .replace(/[.,!?()]/g, '')
        .replace(/\s+/g, ' ');
    const words = cleaned.split(' ')
        .filter(word => word.length > 0)
        .map(word => word.replace(/-/g, ''));
    return words.length;
}

class SectionBulletTracker {
    constructor() {
        this.bulletMap = new Map();
        this.usedBullets = new Set();
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

async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    const basePrompt = `You are a specialized resume bullet point optimizer focused on creating technically accurate and ATS-friendly content. Your task is to generate or enhance resume bullets that demonstrate technical expertise while maintaining STRICTLY ACCURATE technology relationships.

CRITICAL TECHNOLOGY RELATIONSHIP RULES:
1. NEVER combine technologies from different ecosystems that don't naturally work together.
2. Each bullet should focus on 1-2 closely related technologies maximum.
3. Always verify technology relationships before combining them.
4. If unsure about a technology relationship, use only the primary technology.

TECHNOLOGY DOMAIN RULES AND RELATIONSHIPS:
1. Programming Languages & Their Ecosystems:
   - Java → Spring, Hibernate, Maven, JUnit
   - Python → Django, Flask, NumPy, Pandas
   - JavaScript → Node.js, React, Angular, Express
   - TypeScript → Angular, React, Next.js
   - C# → .NET, ASP.NET, Entity Framework
   NEVER MIX: Java with Python libraries, JavaScript with Java frameworks, etc.

2. Front-End Development:
   - React → Redux, React Router, Material-UI
   - Angular → RxJS, NgRx, Angular Material
   - Vue.js → Vuex, Vue Router
   NEVER MIX: React hooks with Angular services, Vue with Redux, etc.

3. Back-End & Databases:
   - Node.js → Express, MongoDB, Mongoose
   - Django → PostgreSQL, SQLite
   - Spring → MySQL, Oracle, Hibernate
   NEVER MIX: Django ORM with MongoDB, Hibernate with MongoDB, etc.

4. Cloud & DevOps:
   - AWS → EC2, S3, Lambda, CloudFormation
   - Azure → App Service, Functions, DevOps
   - GCP → Compute Engine, Cloud Functions
   NEVER MIX: AWS services with Azure-specific terms, GCP with AWS-specific services.

5. Mobile Development:
   - iOS → Swift, SwiftUI, Cocoa Touch
   - Android → Kotlin, Java, Android SDK
   - React Native → JavaScript, React
   NEVER MIX: Swift with Android SDK, Kotlin with iOS frameworks.

6. CRM & Business Systems:
   - Salesforce → Apex, Visualforce, Lightning
   - Microsoft Dynamics → C#, .NET
   NEVER MIX: Apex with Java/Python, Salesforce-specific with general web tech.

INVALID COMBINATION EXAMPLES (NEVER GENERATE THESE):
❌ "Developed Apex triggers using Java" (Apex is Salesforce-specific)
❌ "Built React components using Angular services" (Different frameworks)
❌ "Implemented Django models with MongoDB" (Django uses SQL databases)
❌ "Created AWS Lambda functions using Azure Functions" (Different clouds)
❌ "Developed iOS apps using Android SDK" (Different mobile platforms)

FORMATTING RULES:
1. Every bullet MUST start with '>>' (no space after).
2. One specific metric per bullet (%, $, time, or quantity).
3. Each bullet MUST begin with a strong, unique action verb.
4. NEVER reuse the same starting verb across bullet points.
5. Each bullet MUST be ${wordLimit} words or less.

KEYWORD INTEGRATION RULES:
1. **EACH PROVIDED KEYWORD MUST APPEAR AT LEAST ONCE ACROSS THE FINAL SET OF BULLETS.**
2. Distribute keywords naturally; avoid obvious keyword stuffing.
3. Technologies MUST be from the same domain or have a clear, logical relationship.
4. Use ONLY 1-2 related technologies per bullet; other keywords should be blended into context, not as additional tech stacks.
5. If a technology doesn't fit naturally, preserve the achievement without that tech reference, but all non-tech keywords must still appear.

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
1. Keep all existing numbers EXACTLY as provided.
2. Each bullet MUST include ONE specific metric:
   - Percentages (e.g., "reduced costs by 40%")
   - Time (e.g., "decreased load time by 2.5 seconds")
   - Quantity (e.g., "supported 100K users")
   - Money (e.g., "saved $50K annually")

INPUT TO ENHANCE:
${(existingBullets || []).join('\n')}`;

    const prompt = mode === 'tailor'
      ? `${basePrompt}

TASK: Substantially rewrite and enhance the above bullets so that **ALL PROVIDED KEYWORDS ARE COVERED ACROSS THE BULLET SET**. CRITICAL: Maintain original metrics and achievements while completely rephrasing each bullet for maximum impact. MOST IMPORTANTLY: Ensure all technology combinations are logically valid per the rules above.`
      : `${basePrompt}

TASK: Generate **15 achievement-focused bullets** ${context} with concrete metrics, varied action verbs, and **ENSURE EVERY KEYWORD IS USED AT LEAST ONCE ACROSS THE BULLET SET**. MOST IMPORTANTLY: Ensure all technology combinations are logically valid per the rules above.`;

    try {
        console.log('Generating bullets with mode:', mode);
        console.log('Existing bullets:', existingBullets);
        console.log('Keywords:', keywords);
        
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized resume bullet point optimizer with deep understanding of technology relationships. You must NEVER generate bullets with invalid technology combinations. First analyze the keywords to understand their relationships, then generate bullets ensuring technical accuracy."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.7,
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
        console.log('Raw LLM response:', content);
        
        const lines = content.split('\n');
        console.log('Split lines:', lines);
        
        const seenBullets = new Set();
        const bullets = lines
            .map(line => line.trim())
            .filter(line => line.startsWith('>>'))
            .map(bullet => {
                console.log('Processing bullet:', bullet);
                return bullet.replace(/^>>\s*/, '')
                          .replace(/\*\*/g, '')
                          .replace(/\s*\([^)]*\)$/, '');
            })
            .filter(bullet => {
                const norm = bullet.toLowerCase().replace(/\s+/g, ' ').trim();
                console.log('Normalized bullet:', norm);
                if (seenBullets.has(norm)) {
                    console.log('Duplicate bullet found, skipping');
                    return false;
                }
                seenBullets.add(norm);
                return true;
            });
            
        console.log('Final processed bullets:', bullets);
        return bullets;
    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return [];
    }
}

function shuffleBulletsWithVerbCheck(bullets, sectionType, verbTracker) {
    let attempts = 0;
    const maxAttempts = 15;
    while (attempts < maxAttempts) {
        bullets = shuffleArray([...bullets]);
        let isValid = true;
        let previousVerbs = new Set();
        for (let i = 0; i < bullets.length; i++) {
            const currentVerb = getFirstVerb(bullets[i]);
            if (!currentVerb) continue;
            if (previousVerbs.has(currentVerb) || 
                (verbTracker.isVerbUsedGlobally(currentVerb) && i === 0)) {
                isValid = false;
                break;
            }
            previousVerbs.add(currentVerb);
        }
        if (isValid) {
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

async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const allBulletsToProcess = [];
    const ulElements = $('ul');
    console.log(`Found ${ulElements.length} <ul> elements`);
    const bulletListMap = new Map();
    const ulElementMap = new Map();
    
    ulElements.each((index, ul) => {
        const currentUl = $(ul);
        console.log(`Processing ul element #${index + 1}`);
        const liElements = currentUl.children('li');
        console.log(`Found ${liElements.length} bullet points in ul #${index + 1}`);
        const bulletTexts = liElements.map((_, li) => $(li).text().trim()).get();
        console.log(`Extracted ${bulletTexts.length} bullet texts`);
        bulletListMap.set(currentUl, bulletTexts);
        console.log(`Stored bullets for ul #${index + 1} in map`);
        allBulletsToProcess.push(...bulletTexts);
        ulElementMap.set(currentUl, bulletTexts.length);
    });
    
    let processedCount = 0;
    let firstUlElement = null;
    
    const processedBullets = await generateBullets(
        fullTailoring ? 'tailor' : 'generate',
        allBulletsToProcess,
        keywords,
        'for experience section',
        12
    );
    console.log('Generated bullets:', processedBullets.length);
    
    let currentIndex = 0;
    
    for (const [ulElement, originalBullets] of bulletListMap) {
        if (!firstUlElement) firstUlElement = ulElement;
        console.log(`Processing stored ul #${++processedCount}`);
        
        const originalCount = ulElementMap.get(ulElement);
        const endIndex = currentIndex + originalCount;
        const bulletsForCurrentUl = processedBullets.slice(currentIndex, endIndex);
        console.log(`Sliced ${bulletsForCurrentUl.length} bullets for current ul`);
        
        const currentLiElements = ulElement.children('li');
        console.log(`Found ${currentLiElements.length} current li elements to update`);
        
        currentLiElements.each((index, li) => {
            if (index < bulletsForCurrentUl.length) {
                const originalText = $(li).text();
                console.log(`Original bullet #${index + 1}:`, originalText);
                $(li).text(bulletsForCurrentUl[index]);
                console.log(`Updated bullet #${index + 1} to:`, bulletsForCurrentUl[index]);
            }
        });
        console.log(`Updated ${Math.min(currentLiElements.length, bulletsForCurrentUl.length)} bullet points`);
        
        if (currentLiElements.length > bulletsForCurrentUl.length) {
            currentLiElements.slice(bulletsForCurrentUl.length).remove();
            console.log(`Removed ${currentLiElements.length - bulletsForCurrentUl.length} excess bullet points`);
        }
        
        if (bulletsForCurrentUl.length > currentLiElements.length) {
            for (let i = currentLiElements.length; i < bulletsForCurrentUl.length; i++) {
                ulElement.append($('<li>').text(bulletsForCurrentUl[i]));
            }
            console.log(`Added ${bulletsForCurrentUl.length - currentLiElements.length} new bullet points`);
        }
        
        currentIndex = endIndex;
    }
    
    if (firstUlElement) {
        console.log('First UL element HTML after all updates:', firstUlElement.html());
    }
    
    const finalHtml = $.html();
    console.log('Complete HTML output:', finalHtml);
    return finalHtml;
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
            margin: 0.25in;
        }
        body {
            margin: 0;
            padding: 0;
        }
    `;
    await page.setContent(htmlContent);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }, customCSS);
    const height = await checkPageHeight(page);
    const MAX_HEIGHT = 1056;
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

async function customizeResume(req, res) {
    try {
        const { htmlContent, keywords, fullTailoring } = req.body;
        if (!htmlContent || !Array.isArray(keywords)) {
            return res.status(400).send('Invalid input: HTML content and keywords array are required');
        }
        console.log('Received keywords:', keywords);
        console.log('Full tailoring enabled:', fullTailoring);
        if (htmlContent.length < 100) {
            return res.status(400).send('Invalid HTML content: Content too short');
        }
        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);
        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));
    } catch (error) {
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };
