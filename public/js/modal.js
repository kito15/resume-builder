class CustomModal {
    constructor() {
        this.modalTemplate = `
            <div class="custom-modal" id="customModal">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <div class="header-content">
                                <span class="modal-icon"></span>
                                <h5 class="modal-title"></h5>
                            </div>
                            <button type="button" class="close-button" aria-label="Close">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
        this.icons = {
            error: `<svg class="modal-icon" viewBox="0 0 24 24" fill="none" stroke="#dc3545" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12" y2="16"></line>
                    </svg>`,
            warning: `<svg class="modal-icon" viewBox="0 0 24 24" fill="none" stroke="#ffc107" stroke-width="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                        <line x1="12" y1="9" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12" y2="17"></line>
                    </svg>`,
            success: `<svg class="modal-icon" viewBox="0 0 24 24" fill="none" stroke="#28a745" stroke-width="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>`
        };
        this.init();
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

    show(options = {}) {
        const {
            title = '',
            message = '',
            type = 'error',
            html = false
        } = options;

        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.className = 'modal-content modal-' + type;
        
        const iconContainer = this.modal.querySelector('.modal-icon');
        iconContainer.innerHTML = this.icons[type] || '';
        
        const titleElement = this.modal.querySelector('.modal-title');
        titleElement.textContent = title;

        const bodyElement = this.modal.querySelector('.modal-body');
        if (html) {
            bodyElement.innerHTML = message;
        } else {
            bodyElement.textContent = message;
        }

        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        const closeButton = this.modal.querySelector('.close-button');
        setTimeout(() => closeButton.focus(), 100);
    }

    hide() {
        this.modal.classList.remove('show');
        document.body.style.overflow = '';
    }
}

// Create a single instance for global use
const modalInstance = new CustomModal();
window.showModal = (options) => modalInstance.show(options);