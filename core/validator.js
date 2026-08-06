module.exports = {
    formatarNumero: (numero) => {
        if (!numero) return null;
        let numStr = numero.toString().replace(/\D/g, ''); 
        
        if(numStr.length === 0) return null;

        if (numStr.length === 10 || numStr.length === 11) {
            numStr = '55' + numStr;
        }
        
        if (numStr.length >= 12 && numStr.length <= 13) {
            return numStr + '@c.us';
        }
        
        return null;
    }
};