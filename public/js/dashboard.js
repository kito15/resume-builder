document.addEventListener('DOMContentLoaded', function() {
    const mainContent = document.querySelector('.main-content');
    const profileLink = document.querySelector('a[href="#"].nav-link:has(i.fas.fa-user)');
    const dashboardLink = document.querySelector('a[href="#"].nav-link:has(i.fas.fa-home)');
    const notesLink = document.querySelector('a[href="#"].nav-link:has(i.fas.fa-sticky-note)');
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

    // Handle notes link click
    notesLink?.addEventListener('click', async function(e) {
        e.preventDefault();
        
        try {
            // Store current dashboard content if not stored
            if (!dashboardContent) {
                dashboardContent = mainContent.innerHTML;
            }

            // Remove active class from all links and add to notes
            document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
            notesLink.classList.add('active');

            // Show loading state
            mainContent.classList.add('loading');

            // Fetch notes section
            const response = await fetch('/partials/notes-section');
            const notesHTML = await response.text();

            // Update main content
            mainContent.innerHTML = notesHTML;

            // Initialize notes functionality
            initializeNotes();

        } catch (error) {
            console.error('Error loading notes:', error);
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

    // Initialize notes functionality
    function initializeNotes() {
        const searchInput = document.querySelector('.notes-section input[type="search"]');
        const categorySelect = document.querySelector('.notes-section select');
        const quickNoteForm = document.getElementById('quickNoteForm');
        const noteItems = document.querySelectorAll('.note-item');

        // Handle search
        searchInput?.addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            noteItems.forEach(item => {
                const title = item.querySelector('h6').textContent.toLowerCase();
                const content = item.querySelector('.note-preview').textContent.toLowerCase();
                const isVisible = title.includes(searchTerm) || content.includes(searchTerm);
                item.style.display = isVisible ? 'block' : 'none';
            });
        });

        // Handle category filter
        categorySelect?.addEventListener('change', function(e) {
            const category = e.target.value;
            noteItems.forEach(item => {
                if (category === 'all') {
                    item.style.display = 'block';
                } else {
                    const noteCategory = item.querySelector('.badge').textContent.toLowerCase();
                    item.style.display = noteCategory.includes(category) ? 'block' : 'none';
                }
            });
        });

        // Handle quick note form
        quickNoteForm?.addEventListener('submit', function(e) {
            e.preventDefault();
            // Add your note saving logic here
            console.log('Quick note form submitted');
            this.reset();
        });

        // Handle note actions
        document.querySelectorAll('.note-actions button').forEach(button => {
            button.addEventListener('click', function(e) {
                const action = this.querySelector('i').classList.contains('fa-edit') ? 'edit' : 'delete';
                const noteItem = this.closest('.note-item');
                
                if (action === 'edit') {
                    // Add your edit logic here
                    console.log('Edit note:', noteItem);
                } else {
                    // Add your delete logic here
                    console.log('Delete note:', noteItem);
                }
            });
        });
    }
}); 