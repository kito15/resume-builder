const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

const openaiApiKey = process.env.OPENAI_API_KEY;

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

    // Embed the provided keywords explicitly in the prompt so the model is fully aware of what must be covered.
    const keywordsSection = `\n\nPROVIDED KEYWORDS:\n${keywords.join(', ')}`;

    const bulletCount = (existingBullets || []).length;

    const taskPrompt = mode === 'tailor'
      ? `${basePrompt}

TASK: Substantially rewrite and enhance the above bullets so that **ALL PROVIDED KEYWORDS ARE COVERED ACROSS THE BULLET SET**. CRITICAL: Maintain original metrics and achievements while completely rephrasing each bullet for maximum impact. MOST IMPORTANTLY: Ensure all technology combinations are logically valid per the rules above.\n\nOUTPUT REQUIREMENT: You MUST output **exactly ${bulletCount} bullets**, matching the original number provided. Do not add or remove bullets.`
      : `${basePrompt}

TASK: Generate **${bulletCount} achievement-focused bullets** ${context} with concrete metrics, varied action verbs, and **ENSURE EVERY KEYWORD IS USED AT LEAST ONCE ACROSS THE BULLET SET**. MOST IMPORTANTLY: Ensure all technology combinations are logically valid per the rules above.`;

    // Additional verification instructions appended to ensure the model reasons out loud and covers all keywords.
    const verificationInstructions = `\n\nVERIFICATION & COMPLETION INSTRUCTIONS:\n1. After drafting bullets, explicitly list all provided keywords and mark which are already used and which are missing.\n2. If any keywords are missing, thoughtfully revise or expand the bullet set to incorporate EVERY keyword.\n3. Show your reasoning step-by-step out loud by prefixing each reasoning line with 'THOUGHT:'.\n4. Once all keywords are covered, output a line 'FINAL BULLETS:' followed immediately by the complete, verified bullet set, each on its own line and starting with '>>'.`;

    const finalPrompt = `${taskPrompt}${keywordsSection}${verificationInstructions}`;

    try {
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
                        content: finalPrompt
                    }
                ],
                temperature: 0.4,
                max_tokens: 8000,
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
        
        const lines = content.split('\n');
        
        let relevantLines = lines;
        const finalIndex = lines.findIndex(line => line.trim().toUpperCase().startsWith('FINAL BULLETS'));
        if (finalIndex !== -1) {
            relevantLines = lines.slice(finalIndex + 1);
        }
        
        const bullets = relevantLines
            .map(line => line.trim())
            .filter(line => line.startsWith('>>'))
            .map(bullet => {
                // Step-wise cleaning to ensure we do NOT remove the first character of the actual sentence.
                let cleaned = bullet.replace(/^>>\s*/, ''); // Remove leading >> marker

                // Remove common list/bullet prefixes ONLY when they are clearly prefixes.
                cleaned = cleaned
                    // Bulleted characters like •, -, * followed by whitespace
                    .replace(/^\s*[\u2022\-*]\s+/u, '')
                    // Numeric lists: (1) 1) 1. etc.
                    .replace(/^\s*\(?\d+\)?[\.)]\s+/u, '')
                    .replace(/^\s*\(?\d+\.\s+/u, '')
                    // Alphabetic lists: (a) a) a. etc.
                    .replace(/^\s*\(?[A-Za-z]\)?[\.)]\s+/u, '')
                    .replace(/^\s*\(?[A-Za-z]\.\s+/u, '');

                // Remove markdown bold markers and trailing parenthetical notes
                cleaned = cleaned.replace(/\*\*/g, '').replace(/\s*\([^)]*\)$/, '');

                return cleaned.trim();
            });
            
        console.log('Final processed bullets:', bullets);
        return bullets;
    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return [];
    }
}

async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const allBulletsToProcess = [];
    const ulElements = $('ul');
    const bulletListMap = new Map();
    const ulElementMap = new Map();
    
    ulElements.each((index, ul) => {
        const currentUl = $(ul);
        const liElements = currentUl.children('li');
        const bulletTexts = liElements.map((_, li) => $(li).text().trim()).get();
        bulletListMap.set(currentUl, bulletTexts);
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
    
    let currentIndex = 0;
    
    for (const [ulElement, originalBullets] of bulletListMap) {
        if (!firstUlElement) firstUlElement = ulElement;
        
        const originalCount = ulElementMap.get(ulElement);
        const endIndex = currentIndex + originalCount;
        const bulletsForCurrentUl = processedBullets.slice(currentIndex, endIndex);
        
        const currentLiElements = ulElement.children('li');
        
        currentLiElements.each((index, li) => {
            if (index < bulletsForCurrentUl.length) {
                $(li).text(bulletsForCurrentUl[index]);
            }
        });
        
        if (currentLiElements.length > bulletsForCurrentUl.length) {
            currentLiElements.slice(bulletsForCurrentUl.length).remove();
        }
        
        if (bulletsForCurrentUl.length > currentLiElements.length) {
            for (let i = currentLiElements.length; i < bulletsForCurrentUl.length; i++) {
                ulElement.append($('<li>').text(bulletsForCurrentUl[i]));
            }
        }
        
        currentIndex = endIndex;
    }
    
    const finalHtml = $.html();
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
