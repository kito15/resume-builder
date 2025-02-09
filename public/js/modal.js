class CustomModal {
    constructor() {
        this.modalTemplate = `
            <div class="custom-modal" id="customModal">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title"></h5>
                            <button type="button" class="close-button" aria-label="Close">&times;</button>
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
            type = 'error'
        } = options;

        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.className = 'modal-content modal-' + type;
        
        const titleElement = this.modal.querySelector('.modal-title');
        titleElement.textContent = title;

        const bodyElement = this.modal.querySelector('.modal-body');
        bodyElement.textContent = message;

        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    hide() {
        this.modal.classList.remove('show');
        document.body.style.overflow = '';
    }
}

// Create a single instance for global use
const modalInstance = new CustomModal();
window.showModal = (options) => modalInstance.show(options);