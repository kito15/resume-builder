class CustomModal {
    constructor() {
        this.modalTemplate = `
            <div class="custom-modal" id="customModal" role="dialog" aria-modal="true">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="modalTitle"></h5>
                            <button type="button" class="close-button" aria-label="Close">×</button>
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
        this.isAnimating = false;
    }

    init() {
        if (!document.getElementById('customModal')) {
            document.body.insertAdjacentHTML('beforeend', this.modalTemplate);
        }
        this.modal = document.getElementById('customModal');
        this.focusableElements = this.modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        this.bindEvents();
    }

    bindEvents() {
        // Backdrop click handling
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal && !this.isAnimating) {
                this.hide();
            }
        });

        // Close button handling
        const closeButton = this.modal.querySelector('.close-button');
        if (closeButton) {
            closeButton.addEventListener('click', () => !this.isAnimating && this.hide());
        }

        // Dismiss button handling
        const dismissButton = this.modal.querySelector('[data-dismiss="modal"]');
        if (dismissButton) {
            dismissButton.addEventListener('click', () => !this.isAnimating && this.hide());
        }

        // Keyboard handling
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal.classList.contains('show') && !this.isAnimating) {
                this.hide();
            }
            
            // Trap focus within modal when open
            if (e.key === 'Tab' && this.modal.classList.contains('show')) {
                this.handleTabKey(e);
            }
        });

        // Prevent scroll on body when modal is open
        this.modal.addEventListener('show.modal', () => {
            document.body.style.overflow = 'hidden';
        });

        this.modal.addEventListener('hide.modal', () => {
            document.body.style.overflow = '';
        });
    }

    handleTabKey(e) {
        const firstFocusableEl = this.focusableElements[0];
        const lastFocusableEl = this.focusableElements[this.focusableElements.length - 1];

        if (e.shiftKey) {
            if (document.activeElement === firstFocusableEl) {
                lastFocusableEl.focus();
                e.preventDefault();
            }
        } else {
            if (document.activeElement === lastFocusableEl) {
                firstFocusableEl.focus();
                e.preventDefault();
            }
        }
    }

    show(options = {}) {
        if (this.isAnimating) return;
        
        const {
            title = '',
            message = '',
            type = 'error',
            onShow = null,
            onShown = null,
            onHide = null,
            onHidden = null
        } = options;

        this.isAnimating = true;
        
        // Trigger show event
        const showEvent = new CustomEvent('show.modal');
        this.modal.dispatchEvent(showEvent);
        
        if (onShow) onShow();

        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.className = 'modal-content modal-' + type;
        
        const titleElement = this.modal.querySelector('.modal-title');
        titleElement.textContent = title;
        titleElement.setAttribute('id', 'modalTitle');

        const bodyElement = this.modal.querySelector('.modal-body');
        bodyElement.textContent = message;

        // Show modal with animation
        requestAnimationFrame(() => {
            this.modal.classList.add('show');
            
            // Focus first focusable element
            setTimeout(() => {
                this.isAnimating = false;
                if (this.focusableElements.length) {
                    this.focusableElements[0].focus();
                }
                if (onShown) onShown();
            }, 500); // Match CSS transition duration
        });

        // Store callbacks
        this._onHide = onHide;
        this._onHidden = onHidden;
    }

    hide() {
        if (this.isAnimating) return;
        
        this.isAnimating = true;
        
        // Trigger hide event
        const hideEvent = new CustomEvent('hide.modal');
        this.modal.dispatchEvent(hideEvent);
        
        if (this._onHide) this._onHide();

        this.modal.classList.remove('show');
        
        setTimeout(() => {
            this.isAnimating = false;
            if (this._onHidden) this._onHidden();
            
            // Clean up
            this._onHide = null;
            this._onHidden = null;
        }, 500); // Match CSS transition duration
    }
}

// Create a single instance for global use
const modalInstance = new CustomModal();
window.showModal = (options) => modalInstance.show(options);