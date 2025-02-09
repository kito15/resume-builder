class CustomModal {
    constructor() {
        this.modalTemplate = `
            <div class="custom-modal" id="customModal" role="dialog" aria-modal="true">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="modalTitle"></h5>
                            <button type="button" class="close-button" aria-label="Close">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                            </button>
                        </div>
                        <div class="modal-body"></div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-dismiss="modal">Close</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.init();
    }

    init() {
        if (!document.getElementById('customModal')) {
            document.body.insertAdjacentHTML('beforeend', this.modalTemplate);
        }
        this.modal = document.getElementById('customModal');
        this.bindEvents();
        this.setupA11y();
    }

    setupA11y() {
        this.modal.setAttribute('role', 'dialog');
        this.modal.setAttribute('aria-modal', 'true');
        this.trapFocus = this.trapFocus.bind(this);
    }

    trapFocus(e) {
        if (!this.modal.classList.contains('show')) return;

        const focusableElements = this.modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];

        if (e.key === 'Tab') {
            if (e.shiftKey && document.activeElement === firstFocusable) {
                e.preventDefault();
                lastFocusable.focus();
            } else if (!e.shiftKey && document.activeElement === lastFocusable) {
                e.preventDefault();
                firstFocusable.focus();
            }
        }
    }

    show(options = {}) {
        const {
            title = '',
            message = '',
            type = 'error',
            onClose = null
        } = options;

        this.onClose = onClose;
        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.className = `modal-content modal-${type}`;
        
        const titleElement = this.modal.querySelector('.modal-title');
        titleElement.textContent = title;

        const bodyElement = this.modal.querySelector('.modal-body');
        bodyElement.textContent = message;

        // Store the active element to restore focus later
        this.previousActiveElement = document.activeElement;

        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        // Focus the first focusable element
        setTimeout(() => {
            const firstFocusable = this.modal.querySelector('button');
            if (firstFocusable) firstFocusable.focus();
        }, 100);

        // Add focus trap
        document.addEventListener('keydown', this.trapFocus);
    }

    hide() {
        this.modal.classList.remove('show');
        document.body.style.overflow = '';
        
        // Remove focus trap
        document.removeEventListener('keydown', this.trapFocus);

        // Restore focus
        if (this.previousActiveElement) {
            this.previousActiveElement.focus();
        }

        if (typeof this.onClose === 'function') {
            this.onClose();
        }
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

        // Add ripple effect to buttons
        const buttons = this.modal.querySelectorAll('.btn');
        buttons.forEach(button => {
            button.addEventListener('click', (e) => {
                const rect = button.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                
                const ripple = document.createElement('div');
                ripple.style.left = `${x}px`;
                ripple.style.top = `${y}px`;
                ripple.className = 'ripple';
                
                button.appendChild(ripple);
                
                setTimeout(() => ripple.remove(), 1000);
            });
        });
    }
}

// Create a single instance for global use
const modalInstance = new CustomModal();
window.showModal = (options) => modalInstance.show(options);