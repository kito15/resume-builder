const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { PDFDocument } = require('pdf-lib');

const openaiApiKey = process.env.OPENAI_API_KEY;

async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    const basePrompt = `You are a specialized resume bullet-point optimizer focused on creating technically accurate, ATS-friendly content while preserving ALL original metrics and achievements.

========================
CRITICAL TECHNOLOGY RELATIONSHIP RULES
========================
1. NEVER combine technologies from different ecosystems that don't naturally work together.
2. Each bullet should focus on 1-2 closely related technologies maximum.
3. Always verify technology relationships before combining them.
4. If unsure about a technology relationship, use only the primary technology.
5. Remove a technological term ONLY when it does not match any required keyword.

========================
TECHNOLOGY DOMAIN RULES & RELATIONSHIPS (DO NOT BREAK)
========================
• Programming Languages → valid libraries / frameworks  
  - Java → Spring, Hibernate, Maven, JUnit  
  - Python → Django, Flask, NumPy, Pandas  
  - JavaScript → Node.js, React, Angular, Express  
  - TypeScript → Angular, React, Next.js  
  - C# → .NET, ASP.NET, Entity Framework  

• Front-End, Back-End, Cloud, Mobile, CRM, etc.  
  …(same lists as original)…

❌  INVALID COMBINATION EXAMPLES (NEVER GENERATE)  
   - "Developed Apex triggers using Java"  
   - "Built React components using Angular services"  
   - "Implemented Django models with MongoDB"  
   - "Created AWS Lambda functions using Azure Functions"  
   - "Developed iOS apps using Android SDK"  

========================
FORMATTING RULES
========================
1. **Only the finalized bullet set must prefix each bullet with \`>>\` (no space).**  
   *Draft bullets generated during reasoning loops must **not** use this prefix.*
2. One specific metric per bullet (%, $, time, or quantity).
3. Each bullet MUST begin with a unique, strong action verb (no repeats).
4. Each bullet MUST be **${wordLimit} words or fewer**.

========================
ATS-KEYWORD WORKFLOW
========================
1. **Keyword Checklist** - List every provided keyword with a ☐ checkbox.  
2. **Analyze Bullet Points** - For each existing bullet, check ✓ any keyword that appears (exact or close synonym).  
3. **Iterative Enhancement Loop** - 
   • For every ☐ unchecked keyword, revise or add bullets so it fits naturally.  
   • Do **not** change or dilute existing metrics/outcomes.  
   • After each revision, update the checklist; repeat until all boxes are ✓.  
4. **Final Output** -  
   • Output the complete, optimized bullet set (each bullet prefixed with \`>>\`).  
   • Immediately after, show the **fully checked-off checklist** for transparency.

========================
KEYWORD INTEGRATION RULES
========================
1. **Every provided keyword MUST appear at least once.**
2. Distribute keywords naturally; avoid stuffing.
3. Keep tech stacks logically valid (see rules above).
4. Use only 1-2 related technologies per bullet; non-tech keywords may appear in narrative text.
5. If a tech keyword truly conflicts with domain rules, preserve the achievement and omit that term.

========================
ACTION VERB GUIDELINES
========================
✓ Approved: Improved, Increased, Reduced, Decreased, Optimized, Developed, Designed, Implemented, Created, Launched, Led, Directed, Coordinated, Managed, Analyzed, Evaluated, Solved  
✗ Prohibited: Built, Helped, Used, Worked, Orchestrated, Spearheaded, Piloted, Revolutionized, Transformed, Pioneered

========================
METRICS GUIDELINES
========================
• Keep ALL existing numbers EXACTLY as provided.  
• One clear metric per bullet (%, $, time, quantity).

========================
INPUT TO ENHANCE
========================
${(existingBullets || []).join('\n')}`;

    // Embed the provided keywords explicitly in the prompt so the model is fully aware of what must be covered.
    const keywordsSection = `\n\nPROVIDED KEYWORDS:\n${keywords.join(', ')}`;

    const bulletCount = (existingBullets || []).length;

    const taskPrompt = mode === 'tailor'
      ? `${basePrompt}

TASK: Substantially rewrite and enhance the above bullets so that **EVERY PROVIDED KEYWORD IS COVERED** across exactly ${bulletCount} bullets. Maintain ALL original metrics and achievements while rephrasing for impact. Verify all technology combinations are valid.`
      : `${basePrompt}

TASK: Generate **${bulletCount} achievement-focused bullets** ${context}. Use varied action verbs, concrete metrics, and ensure **EVERY KEYWORD IS USED**. Verify all technology combinations are valid.`;

    const verificationInstructions = `\n\nVERIFICATION & COMPLETION INSTRUCTIONS:
1. Produce the Keyword Checklist (☐/✓).
2. Show reasoning lines prefixed with 'THOUGHT:'; draft bullets in this phase must NOT start with '>>'.
3. Iterate until all keywords are ✓.
4. Output 'FINAL BULLETS:' followed by the finalized bullet set, each starting with '>>'.
5. Output the fully checked-off checklist.`;

    const finalPrompt = `${taskPrompt}${keywordsSection}${verificationInstructions}`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-nano",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized resume bullet-point optimizer with deep understanding of technology relationships. NEVER output an invalid technology combination. Follow the ATS-keyword workflow and technology rules strictly."
                    },
                    {
                        role: "user",
                        content: finalPrompt
                    }
                ],
                temperature: 0.4,
                max_tokens: 6000,
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
                let cleaned = bullet;
                cleaned = cleaned.replace(/^>>\s*/, '');
                cleaned = cleaned.replace(/^(?:[>\-–—•*]\s*)+/, '');
                cleaned = cleaned.replace(/^\s*\(?\d+\)?[.\)]\s+/, '');
                cleaned = cleaned.replace(/^\s*\(?[A-Za-z]\)?[.\)]\s+/, '');
                cleaned = cleaned.replace(/\*\*/g, '');
                cleaned = cleaned.replace(/\s*\([^)]*\)$/, '');
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
    // Determine actual PDF page count
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    return { pdfBuffer, height, exceedsOnePage: height > MAX_HEIGHT, pageCount };
}

// Helper to remove one bullet point from the resume HTML
function removeOneBullet(htmlContent) {
    const $ = cheerio.load(htmlContent);
    let maxCount = 0;
    let targetUl = null;
    $('ul').each((i, ul) => {
        const count = $(ul).children('li').length;
        if (count > maxCount) {
            maxCount = count;
            targetUl = $(ul);
        }
    });
    if (targetUl && maxCount > 0) {
        targetUl.children('li').last().remove();
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
        if (htmlContent.length < 100) {
            return res.status(400).send('Invalid HTML content: Content too short');
        }
        // Generate tailored HTML and iteratively trim bullets until the PDF is one page
        let updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        let { pdfBuffer, pageCount } = await convertHtmlToPdf(updatedHtmlContent);
        if (pageCount === 2) {
            console.log('Detected exactly 2-page resume; initiating bullet removal.');
        }
        while (pageCount > 1) {
            console.log(`Resume is ${pageCount} pages; removing a bullet point.`);
            updatedHtmlContent = removeOneBullet(updatedHtmlContent);
            const result = await convertHtmlToPdf(updatedHtmlContent);
            pdfBuffer = result.pdfBuffer;
            pageCount = result.pageCount;
        }
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));
    } catch (error) {
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };
