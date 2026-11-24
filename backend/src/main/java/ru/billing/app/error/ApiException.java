package ru.billing.app.error;

import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String code;
    private final String sourceMessage;
    private final String sourceCode;

    public ApiException(HttpStatus status, String code, String message) {
        this(status, code, message, null);
    }

    public ApiException(HttpStatus status, String code, String detail, String sourceMessage) {
        this(status, code, detail, sourceMessage, null);
    }

    public static ApiException fromSourceCode(HttpStatus status, String code, String detail, String sourceCode) {
        return new ApiException(status, code, detail, sourceCode, sourceCode);
    }

    private ApiException(HttpStatus status, String code, String detail, String sourceMessage, String sourceCode) {
        super(detail);
        this.sourceCode = sourceCode;
        this.sourceMessage = sourceMessage;
        this.status = status;
        this.code = code;
    }

    public HttpStatus getStatus() {
        return status;
    }

    public String getSourceCode() {
        return sourceCode;
    }

    public String getSourceMessage() {
        return sourceMessage;
    }

    public String getCode() {
        return code;
    }
}

