const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { PDFDocument } = require('pdf-lib');

const openaiApiKey = process.env.OPENAI_API_KEY;

async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    const systemPrompt = `You are a resume-bullet optimizer. Your task is to insert EVERY keyword somewhere in the bullet set, keep all original metrics, and obey technology logic.

────────────────────────────
SECTION ❶ — HARD RULES
────────────────────────────
R-1  Metrics stay exactly as written (no edits, no new numbers).  
R-2  Every bullet starts with a UNIQUE, strong action verb.  
R-3  ≤ ${wordLimit} words per bullet.  
R-4  Prefix: ONLY the *final* bullets start with '>>'; drafts do NOT.  
R-5  Anti-Overstuffing: ≤ 3 keywords per bullet.  
R-6  **No Grocery Lists:** never chain >2 keywords with commas; weave them naturally.  
R-7  Tech validity: never mix incompatible ecosystems (see map).  
R-8  Remove a tech term ONLY if it is irrelevant *and* not a keyword.  

────────────────────────────
SECTION ❷ — TECHNOLOGY DOMAIN MAP (abridged)
────────────────────────────
• Java → Spring / Hibernate / Maven / JUnit  
• Python → Django / Flask / NumPy / Pandas  
• JavaScript → Node.js / React / Angular / Express  
• TypeScript → Angular / React / Next.js  
• C# → .NET / ASP.NET / Entity Framework  
• Clouds, mobile, CRM: AWS ≠ Azure ≠ GCP, iOS ≠ Android, etc.  

────────────────────────────
SECTION ❸ — OUTPUT FORMAT REQUIREMENTS
────────────────────────────
1. Start with "FINAL BULLETS:" on its own line
2. Each bullet MUST:
   - Be on its own line
   - Start with ">>" (no space before, one space after)
   - Begin with a unique action verb
   - Include a specific metric
3. No empty lines between bullets
4. No additional formatting or prefixes

Example format:
FINAL BULLETS:
>>First bullet with achievement
>>Second bullet with different achievement
>>Third bullet showing another win

After bullets, show:
CHECKLIST COMPLETE:
✓ keyword1, ✓ keyword2, … ✓ keywordN`;

    const userPrompt = mode === 'tailor'
        ? `TASK: Rewrite these ${existingBullets.length} bullets, incorporating ALL keywords while preserving metrics:

INPUT BULLETS:
${(existingBullets || []).join('\n')}

KEYWORDS TO INCLUDE:
${keywords.join(', ')}

Remember:
1. Output MUST start with "FINAL BULLETS:" followed by bullets
2. Each bullet MUST start with ">>" (no space before)
3. Preserve all original metrics exactly
4. Use each keyword at least once
5. Follow all rules from system prompt`
        : `TASK: Generate ${existingBullets.length} achievement-focused bullets ${context || ''}.

KEYWORDS TO INCLUDE:
${keywords.join(', ')}

Remember:
1. Output MUST start with "FINAL BULLETS:" followed by bullets
2. Each bullet MUST start with ">>" (no space before)
3. Include specific metrics in each bullet
4. Use each keyword at least once
5. Follow all rules from system prompt`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-mini",
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    {
                        role: "user",
                        content: userPrompt
                    }
                ],
                temperature: 0.1,
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
        console.log('Raw API response content:', content);
        
        const lines = content.split('\n');
        
        // Find where the final bullets section starts
        const finalBulletsIndex = lines.findIndex(line => 
            line.trim().toUpperCase().includes('FINAL BULLETS'));
        
        if (finalBulletsIndex === -1) {
            console.error('No FINAL BULLETS section found in response');
            return [];
        }
        
        // Extract bullets after the FINAL BULLETS marker
        const bullets = lines
            .slice(finalBulletsIndex + 1)  // Start after "FINAL BULLETS:"
            .filter(line => line.trim().startsWith('>>'))  // Only get lines starting with '>>'
            .map(bullet => {
                // Clean up the bullet point
                let cleaned = bullet.trim();
                // Remove the '>>' prefix and any leading/trailing whitespace
                cleaned = cleaned.replace(/^>>\s*/, '');
                // Remove any other common bullet point markers
                cleaned = cleaned.replace(/^(?:[>\-–—•*]\s*)+/, '');
                // Remove any numbering
                cleaned = cleaned.replace(/^\s*\(?\d+\)?[.\)]\s+/, '');
                cleaned = cleaned.replace(/^\s*\(?[A-Za-z]\)?[.\)]\s+/, '');
                // Remove any markdown formatting
                cleaned = cleaned.replace(/\*\*/g, '');
                // Remove any trailing parenthetical notes
                cleaned = cleaned.replace(/\s*\([^)]*\)$/, '');
                return cleaned.trim();
            })
            .filter(bullet => bullet.length > 0);  // Remove any empty bullets
            
        console.log('Processed bullets:', bullets);
        
        if (bullets.length === 0) {
            console.error('No valid bullets found in the response');
            console.log('Full response content for debugging:', content);
        }
        
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
