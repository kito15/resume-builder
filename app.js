// app.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { initializeDatabase } = require('./db');  // Database connection
const indexRouter = require('./routes/index');
const authRouter = require('./routes/auth');
const { customizeResume } = require('./resume_processing'); // Import functions
const { checkJobDescription, storeJobDescription } = require('./job_description'); //Import job desc functions

const app = express();
const port = 3000;

// CORS Configuration (same as before, consolidated)
const approvedDomains = [
    'nodejs-production-ee43.up.railway.app',
    'linkedin.com', 'indeed.com', 'glassdoor.com', 'monster.com', 'careerbuilder.com',
    'ziprecruiter.com', 'simplyhired.com', 'flexjobs.com', 'snagajob.com', 'usajobs.gov',
    'idealist.org', 'dice.com', 'wellfound.com', 'angel.co', 'weworkremotely.com', 'remote.co',
    'builtinnyc.com', 'builtinla.com', 'builtinchicago.com', 'builtinaustin.com',
    'builtinboston.com', 'builtinseattle.com', 'builtinsf.com', 'hired.com',
    'google.com/about/careers', 'careers.google.com', 'craigslist.org', 'themuse.com',
    'theladders.com', 'roberthalf.com', 'kellyservices.com', 'adecco.com', 'randstad.com',
    'joinhandshake.com', 'linkup.com', 'jobvite.com', 'github.com/jobs', 'behance.net/jobs',
    'dribbble.com/jobs', 'artstation.com/jobs', 'mediabistro.com', 'journalismjobs.com',
    'higheredjobs.com', 'insidehighered.com/jobs', 'schoolspring.com', 'healthecareers.com',
    'nursingjobs.com', 'allhealthcarejobs.com', 'lawjobs.com', 'ihireaccounting.com',
    'salesgravy.com', 'energyjobline.com', 'manufacturingjobs.com', 'truckingtruth.com',
    'automotivecareers.com', 'wayup.com', 'chegg.com/internships', 'internships.com',
    'upwork.com', 'fiverr.com', 'freelancer.com', 'toptal.com', 'peopleperhour.com',
    '99designs.com', 'thumbtack.com', 'taskrabbit.com', 'guru.com', 'collegerecruiter.com',
    'aftercollege.com', 'job.com', 'vault.com', 'yello.co', 'jobcase.com', 'workable.com',
    'jora.com', 'neuvoo.com', 'careerjet.com', 'talentzoo.com', 'clearancejobs.com',
    'efinancialcareers.com', 'rigzone.com', 'coolworks.com', 'entertainmentcareers.net',
    'productionhub.com', 'poachedjobs.com', 'goodfoodjobs.com', 'starchefs.com',
    'campleaders.com', 'k12jobspot.com', 'localwise.com', 'authenticjobs.com',
    'climatebase.org', 'pocitjobs.com', 'diversityjobs.com', 'vetjobs.com',
    'hirepurpose.com', 'workforce50.com', 'retiredbrains.com', 'aarp.org/jobs',
    'ratracerebellion.com', 'otta.com', 'biospace.com', 'pdnjobs.com', 'medreps.com',
    'cryptojobslist.com', 'gun.io', '6figurejobs.com', 'krop.com', 'nurse.com',
    'productionbeast.com', 'salesjobs.com', 'techcareers.com', 'travelnursesource.com',
    'writerswrite.com', 'lever.co', 'greenhouse.io', 'workday.com', 'bamboohr.com',
    'smartrecruiters.com'
];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const allowedOrigins = [
            /^chrome-extension:\/\/[a-z]{32}$/,
            'https://nodejs-production-ee43.up.railway.app',
            ...approvedDomains.map(d =>
                new RegExp(`^(https?://(.*\\.)?${d.replace(/\./g, '\\.')})(:[0-9]+)?$`)
            )
        ];
        if (allowedOrigins.some(pattern => typeof pattern === 'string' ? origin === pattern : pattern.test(origin))) {
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
app.options('*', cors(corsOptions));
app.use(bodyParser.text({ type: 'text/html' }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
app.use('/', indexRouter);
app.use('/auth', authRouter);
app.use(express.static('public'));

// API Endpoints (using imported functions)
app.post('/customize-resume', customizeResume);
app.post('/check-job', checkJobDescription);
app.post('/store-job', storeJobDescription);

// Initialize database and start server
initializeDatabase()
    .then(() => {
        app.listen(port, () => {
            console.log(`Server running at http://localhost:${port}`);
        });
    })
    .catch(console.error);
