// Add this after your existing scripts
document.addEventListener('DOMContentLoaded', function() {
    // Intersection Observer for fade-in sections
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
            }
        });
    }, { threshold: 0.1 });

    // Observe all sections
    document.querySelectorAll('.fade-in-section').forEach((section) => {
        observer.observe(section);
    });

    // Mobile menu functionality
    const hamburger = document.getElementById('hamburger');
    const mobileMenu = document.getElementById('mobile-menu');
    const menuBackdrop = document.getElementById('menu-backdrop');

    function toggleMenu() {
        hamburger.classList.toggle('active');
        mobileMenu.classList.toggle('active');
        menuBackdrop.classList.toggle('active');
        document.body.classList.toggle('overflow-hidden');
    }

    hamburger?.addEventListener('click', toggleMenu);
    menuBackdrop?.addEventListener('click', toggleMenu);

    // Close menu on navigation
    const mobileLinks = document.querySelectorAll('.mobile-link');
    mobileLinks.forEach(link => {
        link.addEventListener('click', toggleMenu);
    });
});