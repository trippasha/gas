// Оскільки цей файл є класичним скриптом, ми використовуємо 'await import'
// для отримання функцій Firestore усередині async-функцій.

class GasMonitor {
    constructor() {
        // Перевіряємо, чи ініціалізовано Firebase
        if (!window.db) {
            console.error("Firebase Firestore не доступно. Перевірте index.html.");
            return;
        }
        this.db = window.db;
        this.data = []; // Дані, завантажені з Firebase
        this.collectionName = "gas_readings";
        this.init();
    }

    async init() {
        this.setMinDate();
        await this.loadGasDataFromFirebase(); // Асинхронне завантаження даних
        this.setupEventListeners();
    }

    // --- Нова логіка для Firestore ---

    // Функція для завантаження всіх даних з Firestore
    async loadGasDataFromFirebase() {
        try {
            // Імпортуємо необхідні функції Firestore
            const { collection, query, orderBy, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

            // Отримуємо посилання на колекцію, сортуючи за часом створення
            const q = query(collection(this.db, this.collectionName), orderBy("timestamp", "asc"));
            
            const querySnapshot = await getDocs(q);
            const loadedData = [];
            
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                loadedData.push({
                    id: doc.id, // Зберігаємо ID для подальшого видалення
                    date: data.date,
                    gasReading: data.gasReading,
                    temperature: data.temperature,
                    timestamp: data.timestamp ? data.timestamp.toDate() : null
                });
            });

            this.data = loadedData;
            this.render(); // Оновлюємо таблицю та графік після завантаження
            
        } catch (error) {
            console.error("Помилка завантаження даних з Firebase:", error);
            alert("Помилка завантаження даних. Перевірте консоль.");
        }
    }

    // Функція для збереження даних у Firestore
    async saveGasDataToFirebase(newEntry) {
        try {
            const { collection, addDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
            
            const dataToSave = {
                date: newEntry.date,
                gasReading: newEntry.gasReading,
                temperature: newEntry.temperature,
                timestamp: serverTimestamp() // Час, встановлений сервером
            };

            const docRef = await addDoc(collection(this.db, this.collectionName), dataToSave);
            
            // Додаємо новий запис з ID до локального масиву для негайного відображення
            this.data.push({
                ...newEntry, 
                id: docRef.id,
                timestamp: new Date()
            }); 
            
            this.render();

        } catch (error) {
            console.error("Помилка запису даних до Firebase:", error);
            alert("Помилка збереження даних. Перевірте консоль.");
        }
    }
    
    // Функція для видалення даних з Firestore
    async deleteDataFromFirebase(docId) {
        try {
            const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
            
            await deleteDoc(doc(this.db, this.collectionName, docId));
            
            // Видаляємо з локального масиву
            this.data = this.data.filter(entry => entry.id !== docId);
            
            this.render();

        } catch (error) {
            console.error("Помилка видалення даних з Firebase:", error);
            alert("Помилка видалення даних. Перевірте консоль.");
        }
    }
    
    // --- Модифікація існуючих методів ---
    
    // Викликається після loadGasDataFromFirebase
    render() {
        this.renderTable();
        this.renderChart();
    }

    // addData тепер асинхронний і викликає saveGasDataToFirebase
    async addData() {
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
        };

        // Зберігаємо дані в бекенд (асинхронно)
        await this.saveGasDataToFirebase(newEntry);
        
        // Очищення форми
        document.getElementById('dataForm').reset();
        this.setMinDate();
    }
    
    // Метод для розрахунку різниці
    getAllData() {
        // Початкові дані, які не зберігаються у Firebase
        const initialData = this.getInitialData(); 
        
        // Об'єднуємо початкові дані та дані з Firebase
        const combinedData = [...initialData, ...this.data];
        
        // Перераховуємо різниці
        return combinedData.map((entry, index) => {
            let difference = 0;
            
            if (index > 0) {
                // Віднімаємо від попереднього запису в об'єднаному масиві
                const lastEntry = combinedData[index - 1];
                difference = entry.gasReading - lastEntry.gasReading;
            } else if (entry.difference !== undefined) {
                // Якщо це перший запис, використовуємо його difference (якщо є)
                difference = entry.difference;
            }
            
            return {
                ...entry,
                difference: parseFloat(difference.toFixed(2))
            };
        });
    }

    // Метод видалення тепер повинен використовувати Firebase ID
    deleteData(entryIndex) {
        const initialDataLength = this.getInitialData().length;

        if (entryIndex < initialDataLength) {
            alert('Початкові дані не можуть бути видалені. Це лише приклад.');
            return;
        }

        // Індекс у масиві this.data (дані, завантажені з Firebase)
        const firebaseIndex = entryIndex - initialDataLength;
        const entryToDelete = this.data[firebaseIndex];

        if (entryToDelete && confirm(`Ви впевнені, що хочете видалити запис від ${this.formatDate(entryToDelete.date)}?`)) {
            // Викликаємо функцію видалення з Firebase
            this.deleteDataFromFirebase(entryToDelete.id);
        }
    }
    
    // Видаляємо старі методи localStorage
    // loadData() {}
    // saveData() {}

    // ... (setMinDate, setupEventListeners, getInitialData, formatDate, renderChart залишаються незмінними) ...
    
    // Виправлений renderTable для коректного відображення ID та кнопки
    renderTable() {
        const tbody = document.getElementById('tableBody');
        tbody.innerHTML = '';

        const allData = this.getAllData();
        const initialDataLength = this.getInitialData().length;

        allData.forEach((entry, index) => {
            const row = document.createElement('tr');
            
            const differenceClass = entry.difference > 0 ? 'difference-positive' : 
                                  entry.difference < 0 ? 'difference-negative' : 'difference-zero';
            
            const isDeletable = index >= initialDataLength;

            row.innerHTML = `
                <td class="${differenceClass}">${entry.difference}</td>
                <td>${this.formatDate(entry.date)}</td>
                <td>${entry.gasReading}</td>
                <td>${entry.temperature !== null ? entry.temperature + '°C' : 'Н/Д'}</td>
                <td>
                    ${isDeletable ? 
                        `<button class="delete-btn" onclick="gasMonitor.deleteData(${index})">Видалити</button>` : 
                        ''
                    }
                </td>
            `;
            tbody.appendChild(row);
        });
    }

    setMinDate() {
        const dateInput = document.getElementById('date');
        const today = new Date().toISOString().split('T')[0];
        dateInput.value = today;
        dateInput.max = today;
    }

    getInitialData() {
        return [
            { date: '2022-11-22', gasReading: 73435, temperature: 4.5, difference: 0 },
            { date: '2022-11-23', gasReading: 73455, temperature: -1, difference: 20 },
            { date: '2022-11-24', gasReading: 73471, temperature: 0, difference: 16 },
            { date: '2022-11-25', gasReading: 73484, temperature: 3, difference: 13 }
        ];
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
                // ... (options залишаються незмінними)
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
}

// Ініціалізація додатку: перевіряємо, чи DB готова
document.addEventListener('DOMContentLoaded', () => {
    // Невеликий тайм-аут, щоб переконатися, що модульний скрипт Firebase завершив роботу
    setTimeout(() => {
         if (window.db) {
             window.gasMonitor = new GasMonitor();
         } else {
             console.error("Критична помилка: Firebase DB не доступна. Перевірте, чи виконався <script type=\"module\">");
         }
    }, 500); 
});