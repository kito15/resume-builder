class CustomModal {
    constructor() {
        this.modalTemplate = `
            <div class="custom-modal" id="customModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-describedby="modalBody">
                <div class="modal-dialog" role="document">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="modalTitle"></h5>
                            <button type="button" class="close-button" aria-label="Close modal">
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M4 4l8 8m0-8l-8 8" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                        <div class="modal-body" id="modalBody"></div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-dismiss="modal">Close</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.init();
        this.lastActiveElement = null;
    }

    init() {
        if (!document.getElementById('customModal')) {
            document.body.insertAdjacentHTML('beforeend', this.modalTemplate);
        }
        this.modal = document.getElementById('customModal');
        this.bindEvents();
    }

    bindEvents() {
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.hide();
            }
        });

        const closeButton = this.modal.querySelector('.close-button');
        if (closeButton) {
            closeButton.addEventListener('click', () => this.hide());
        }

        const dismissButton = this.modal.querySelector('[data-dismiss="modal"]');
        if (dismissButton) {
            dismissButton.addEventListener('click', () => this.hide());
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal.classList.contains('show')) {
                this.hide();
            }
        });

        // Trap focus within modal
        this.modal.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                const focusableElements = this.modal.querySelectorAll(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                );
                const firstFocusable = focusableElements[0];
                const lastFocusable = focusableElements[focusableElements.length - 1];

                if (e.shiftKey) {
                    if (document.activeElement === firstFocusable) {
                        lastFocusable.focus();
                        e.preventDefault();
                    }
                } else {
                    if (document.activeElement === lastFocusable) {
                        firstFocusable.focus();
                        e.preventDefault();
                    }
                }
            }
        });
    }

    show(options = {}) {
        const {
            title = '',
            message = '',
            type = 'error'
        } = options;

        // Store last active element to return focus later
        this.lastActiveElement = document.activeElement;

        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.className = 'modal-content modal-' + type;
        
        const titleElement = this.modal.querySelector('.modal-title');
        titleElement.textContent = title;

        const bodyElement = this.modal.querySelector('.modal-body');
        bodyElement.textContent = message;

        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        // Focus first focusable element
        const closeButton = this.modal.querySelector('.close-button');
        closeButton.focus();

        // Announce to screen readers
        const announcement = document.createElement('div');
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        announcement.className = 'sr-only';
        announcement.textContent = `${title}. ${message}`;
        document.body.appendChild(announcement);
        setTimeout(() => announcement.remove(), 1000);
    }

    hide() {
        this.modal.classList.remove('show');
        document.body.style.overflow = '';
        
        // Return focus to last active element
        if (this.lastActiveElement) {
            this.lastActiveElement.focus();
        }
    }
}

// Create a single instance for global use
const modalInstance = new CustomModal();
window.showModal = (options) => modalInstance.show(options);