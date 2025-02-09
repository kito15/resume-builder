class CustomModal {
    constructor() {
        this.modalTemplate = `
            <div class="custom-modal" id="customModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <div class="modal-title-wrapper">
                                <span class="modal-icon"></span>
                                <h5 class="modal-title" id="modalTitle"></h5>
                            </div>
                            <button type="button" class="close-button" aria-label="Close">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                        <div class="modal-body"></div>
                        <div class="modal-footer">
                            <button type="button" class="modal-btn btn-secondary" data-dismiss="modal">
                                <span class="btn-text">Dismiss</span>
                            </button>
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

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal.classList.contains('show')) {
                this.hide();
            }
        });
    }

    getIcon(type) {
        const iconColor = type === 'error' ? 'var(--color-error)' : 
                         type === 'warning' ? 'var(--color-warning)' : 'var(--color-success)';
        
        const icons = {
            error: `<svg class="status-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconColor}">
                <circle cx="12" cy="12" r="10" stroke-width="2"/>
                <path d="M12 8v4m0 4h.01" stroke-width="2" stroke-linecap="round"/>
            </svg>`,
            warning: `<svg class="status-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconColor}">
                <path d="M12 9v4m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 18c-.77 1.333.192 3 1.732 3z" stroke-width="2"/>
            </svg>`,
            success: `<svg class="status-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconColor}">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
            </svg>`
        };
        
        return icons[type] || icons.error;
    }

    show(options = {}) {
        const {
            title = '',
            message = '',
            type = 'error',
            dismissable = true,
            buttonText = 'Dismiss'
        } = options;

        // Store currently focused element
        this.previousActiveElement = document.activeElement;

        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.className = `modal-content modal-${type}`;
        
        const iconContainer = this.modal.querySelector('.modal-icon');
        iconContainer.innerHTML = this.getIcon(type);

        const titleElement = this.modal.querySelector('.modal-title');
        titleElement.textContent = title;

        const bodyElement = this.modal.querySelector('.modal-body');
        bodyElement.innerHTML = message;

        const dismissButton = this.modal.querySelector('[data-dismiss="modal"]');
        dismissButton.querySelector('.btn-text').textContent = buttonText;

        // Add show class to trigger animations
        this.modal.classList.add('show');
        modalContent.classList.add('modal-enter');
        
        // Lock body scroll
        document.body.style.overflow = 'hidden';

        // Focus the close button after animation
        setTimeout(() => {
            this.modal.querySelector('.close-button').focus();
            modalContent.classList.remove('modal-enter');
        }, 300);

        // Trigger haptic feedback on mobile if available
        if (window.navigator.vibrate) {
            window.navigator.vibrate(50);
        }
    }

    hide() {
        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.classList.add('modal-leave');

        setTimeout(() => {
            this.modal.classList.remove('show');
            document.body.style.overflow = '';
            modalContent.classList.remove('modal-leave');

            // Restore focus to previous element
            if (this.previousActiveElement) {
                this.previousActiveElement.focus();
            }
        }, 200);
    }
}

// Create a single instance for global use
const modalInstance = new CustomModal();
window.showModal = (options) => modalInstance.show(options);