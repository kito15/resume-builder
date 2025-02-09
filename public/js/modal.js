class CustomModal {
    constructor() {
        this.modalTemplate = `
            <div class="custom-modal" id="customModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="modalTitle"></h5>
                            <button type="button" class="close-button" aria-label="Close">
                                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                                    <path d="M15 5L5 15M5 5l10 10"/>
                                </svg>
                            </button>
                        </div>
                        <div class="modal-body"></div>
                        <div class="modal-footer">
                            <button type="button" class="modal-btn btn-secondary" data-dismiss="modal">Dismiss</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.init();
        this.previousActiveElement = null;
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

        // Handle keyboard interactions
        document.addEventListener('keydown', (e) => {
            if (!this.modal.classList.contains('show')) return;
            
            if (e.key === 'Escape') {
                this.hide();
            }
            
            // Trap focus inside modal when open
            if (e.key === 'Tab') {
                this.handleTabKey(e);
            }
        });

        // Prevent page scroll when modal is open
        this.modal.addEventListener('touchmove', (e) => {
            if (e.target === this.modal) {
                e.preventDefault();
            }
        }, { passive: false });
    }

    handleTabKey(e) {
        const focusableElements = this.modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
            if (document.activeElement === firstElement) {
                lastElement.focus();
                e.preventDefault();
            }
        } else {
            if (document.activeElement === lastElement) {
                firstElement.focus();
                e.preventDefault();
            }
        }
    }

    getIcon(type) {
        const iconColor = type === 'error' ? '#dc3545' : 
                         type === 'warning' ? '#ffc107' : '#10b981';
        
        return type === 'error' ? `
            <svg class="modal-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4m0 4h.01"/>
            </svg>
        ` : type === 'warning' ? `
            <svg class="modal-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2">
                <path d="M12 9v4m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 18c-.77 1.333.192 3 1.732 3z"/>
            </svg>
        ` : `
            <svg class="modal-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
        `;
    }

    show(options = {}) {
        const {
            title = '',
            message = '',
            type = 'error'
        } = options;

        // Store the currently focused element
        this.previousActiveElement = document.activeElement;

        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.className = 'modal-content modal-' + type;
        
        const titleElement = this.modal.querySelector('.modal-title');
        titleElement.innerHTML = `${this.getIcon(type)} ${title}`;

        const bodyElement = this.modal.querySelector('.modal-body');
        bodyElement.textContent = message;

        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        // Focus the close button
        const closeButton = this.modal.querySelector('.close-button');
        setTimeout(() => closeButton.focus(), 100);

        // Add animation class
        requestAnimationFrame(() => {
            modalContent.style.transform = 'scale(1)';
            modalContent.style.opacity = '1';
        });
    }

    hide() {
        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.style.transform = 'scale(0.95)';
        modalContent.style.opacity = '0';

        setTimeout(() => {
            this.modal.classList.remove('show');
            document.body.style.overflow = '';

            // Restore focus to the previously focused element
            if (this.previousActiveElement) {
                this.previousActiveElement.focus();
            }
        }, 200);
    }
}

// Create a single instance for global use
const modalInstance = new CustomModal();
window.showModal = (options) => modalInstance.show(options);