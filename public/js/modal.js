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
            type = 'error',
            motionCurve = 'default'
        } = options;

        const modalContent = this.modal.querySelector('.modal-content');
        modalContent.className = `modal-content modal-${type}`;
        
        // Set motion curve based on context
        const curves = {
            alert: 'cubic-bezier(0.68, -0.55, 0.27, 1.55)',
            success: 'cubic-bezier(0.18, 0.89, 0.32, 1.28)',
            default: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
        };
        this.modal.style.setProperty('--motion-curve', curves[motionCurve] || curves.default);

        // Animate elements sequentially
        anime({
            targets: [this.modal.querySelector('.modal-header'), this.modal.querySelector('.modal-body'), this.modal.querySelector('.modal-footer')],
            opacity: [0, 1],
            translateY: [20, 0],
            delay: anime.stagger(80),
            easing: 'easeOutExpo',
            duration: 400
        });

        const titleElement = this.modal.querySelector('.modal-title');
        titleElement.textContent = title;

        const bodyElement = this.modal.querySelector('.modal-body');
        bodyElement.textContent = message;

        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    hide() {
        anime({
            targets: this.modal.querySelector('.modal-dialog'),
            translateY: 40,
            rotateX: '-3deg',
            rotateY: '2deg',
            opacity: 0,
            duration: 300,
            easing: 'easeInOutQuad',
            complete: () => {
                this.modal.classList.remove('show');
                document.body.style.overflow = '';
            }
        });
    }
}

// Create a single instance for global use
const modalInstance = new CustomModal();
window.showModal = (options) => modalInstance.show(options);