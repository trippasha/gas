class GasMonitor {
    constructor() {
        this.data = this.loadData();
        this.init();
    }

    init() {
        this.setMinDate();
        this.renderTable();
        this.renderChart();
        this.setupEventListeners();
    }

    setMinDate() {
        const dateInput = document.getElementById('date');
        const today = new Date().toISOString().split('T')[0];
        dateInput.value = today;
        dateInput.max = today;
    }

    setupEventListeners() {
        document.getElementById('dataForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.addData();
        });
    }

    addData() {
        const date = document.getElementById('date').value;
        const gasReading = parseFloat(document.getElementById('gasReading').value);
        const temperature = parseFloat(document.getElementById('temperature').value);

        if (!date || isNaN(gasReading) || isNaN(temperature)) {
            alert('Будь ласка, заповніть всі поля коректно');
            return;
        }

        const newEntry = {
            date,
            gasReading,
            temperature,
            difference: this.calculateDifference(gasReading)
        };

        this.data.push(newEntry);
        this.saveData();
        this.renderTable();
        this.renderChart();
        document.getElementById('dataForm').reset();
        this.setMinDate();
    }

    calculateDifference(currentReading) {
        if (this.data.length === 0) {
            // Якщо це перший запис, перевіряємо початкові дані
            const initialData = this.getInitialData();
            if (initialData.length > 0) {
                const lastInitial = initialData[initialData.length - 1];
                return currentReading - lastInitial.gasReading;
            }
            return 0;
        }
        
        const lastReading = this.data[this.data.length - 1].gasReading;
        return currentReading - lastReading;
    }

    getInitialData() {
        return [
            { date: '2022-11-22', gasReading: 73435, temperature: 4.5, difference: 0 },
            { date: '2022-11-23', gasReading: 73455, temperature: -1, difference: 20 },
            { date: '2022-11-24', gasReading: 73471, temperature: 0, difference: 16 },
            { date: '2022-11-25', gasReading: 73484, temperature: 3, difference: 13 }
        ];
    }

    getAllData() {
        const initialData = this.getInitialData();
        // Перераховуємо різниці для всіх даних
        const allData = [...initialData];
        
        // Додаємо дані з localStorage та перераховуємо різниці
        this.data.forEach((entry, index) => {
            let difference;
            if (index === 0) {
                // Перший запис з localStorage - віднімаємо від останнього початкового запису
                const lastInitial = initialData[initialData.length - 1];
                difference = entry.gasReading - lastInitial.gasReading;
            } else {
                // Наступні записи - віднімаємо від попереднього запису в localStorage
                difference = entry.gasReading - this.data[index - 1].gasReading;
            }
            
            allData.push({
                ...entry,
                difference: difference
            });
        });

        return allData;
    }

    deleteData(index) {
        if (confirm('Ви впевнені, що хочете видалити цей запис?')) {
            this.data.splice(index, 1);
            this.saveData();
            this.renderTable();
            this.renderChart();
        }
    }

    renderTable() {
        const tbody = document.getElementById('tableBody');
        tbody.innerHTML = '';

        const allData = this.getAllData();

        allData.forEach((entry, index) => {
            const row = document.createElement('tr');
            
            const differenceClass = entry.difference > 0 ? 'difference-positive' : 
                                  entry.difference < 0 ? 'difference-negative' : 'difference-zero';
            
            row.innerHTML = `
                <td class="${differenceClass}">${entry.difference}</td>
                <td>${this.formatDate(entry.date)}</td>
                <td>${entry.gasReading}</td>
                <td>${entry.temperature !== null ? entry.temperature + '°C' : 'Н/Д'}</td>
                <td>
                    ${index >= this.getInitialData().length ? 
                        `<button class="delete-btn" onclick="gasMonitor.deleteData(${index - this.getInitialData().length})">Видалити</button>` : 
                        ''}
                </td>
            `;
            tbody.appendChild(row);
        });
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString('uk-UA');
    }

    renderChart() {
        const ctx = document.getElementById('gasChart').getContext('2d');
        
        const allData = this.getAllData().filter(entry => entry.temperature !== null);

        const labels = allData.map(entry => this.formatDate(entry.date));
        const differences = allData.map(entry => entry.difference);
        const temperatures = allData.map(entry => entry.temperature);

        if (window.gasChartInstance) {
            window.gasChartInstance.destroy();
        }

        window.gasChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Різниця показників газу',
                        data: differences,
                        borderColor: '#667eea',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Температура (°C)',
                        data: temperatures,
                        borderColor: '#e53e3e',
                        backgroundColor: 'rgba(229, 62, 62, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: 'Різниця газу'
                        }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Температура (°C)'
                        },
                        grid: {
                            drawOnChartArea: false,
                        },
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                    },
                    title: {
                        display: true,
                        text: 'Динаміка показників газу та температури'
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.datasetIndex === 0) {
                                    label += context.parsed.y + ' (різниця)';
                                } else {
                                    label += context.parsed.y + '°C';
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });
    }

    saveData() {
        localStorage.setItem('gasMonitorData', JSON.stringify(this.data));
    }

    loadData() {
        const saved = localStorage.getItem('gasMonitorData');
        return saved ? JSON.parse(saved) : [];
    }
}

// Ініціалізація додатку
const gasMonitor = new GasMonitor();