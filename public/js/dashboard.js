document.addEventListener('DOMContentLoaded', function() {
    const mainContent = document.querySelector('.main-content');
    const profileLink = document.querySelector('a[href="#"].nav-link:has(i.fas.fa-user)');
    const dashboardLink = document.querySelector('a[href="#"].nav-link:has(i.fas.fa-home)');
    let dashboardContent = null;

    profileLink.addEventListener('click', async function(e) {
        e.preventDefault();
        
        try {
            // Store current dashboard content if not stored
            if (!dashboardContent) {
                dashboardContent = mainContent.innerHTML;
            }

            // Remove active class from all links and add to profile
            document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
            profileLink.classList.add('active');

            // Show loading state
            mainContent.classList.add('loading');

            // Fetch profile section
            const response = await fetch('/partials/profile-section');
            const profileHTML = await response.text();

            // Update main content
            mainContent.innerHTML = profileHTML;

        } catch (error) {
            console.error('Error loading profile:', error);
        } finally {
            mainContent.classList.remove('loading');
        }
    });

    // Handle dashboard link click
    dashboardLink.addEventListener('click', function(e) {
        e.preventDefault();
        
        if (dashboardContent) {
            // Remove active class from all links and add to dashboard
            document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
            dashboardLink.classList.add('active');

            // Restore dashboard content
            mainContent.innerHTML = dashboardContent;
        }
    });
}); 